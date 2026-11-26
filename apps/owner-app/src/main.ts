import "./styles.css";
import { HttpOwnerApi } from "./api.js";
import { app, closeAllSheets, paint, parseHash, refresh, selectAgent, startPolling } from "./app.js";
import { isStandalone, parsePairing, store, type Pairing } from "./auth.js";
import { MockOwnerApi } from "./mock.js";
import { activity } from "./screens/activity.js";
import { autoPrompt } from "./screens/approval.js";
import { detail } from "./screens/detail.js";
import { installGuide, pairScreen, pinSetup, splash, unlock } from "./screens/gates.js";
import { deposit, home } from "./screens/home.js";
import { agentSetup, connect, leaveConnect } from "./screens/onboard.js";
import { policy, settings } from "./screens/more.js";
import { openApproval } from "./screens/approval.js";
import { checkNotifications } from "./notify.js";
import { agentEdit } from "./screens/agent.js";
import { hideComposer } from "./composer.js";

const FORCE_MOCK = import.meta.env.VITE_MOCK === "1";
/** 알림으로 열었는데 요청 목록을 아직 못 받았을 때 기다리는 요청 id */
let pendingReq: string | undefined;

/** 데모: 홈을 6초쯤 본 뒤에 "처음 보는 판매자" 구매 요청이 온다 (일을 맡기면 그 일로 더 일찍) */
let demoTimer: number | undefined;

function render(): void {
  const r = app.route;
  // 에이전트 편집·기본 규칙은 그 에이전트의 정책·잔액으로 그린다
  if ((r.name === "agent" || r.name === "setup") && app.data.agents.some((a) => a.id === r.id) && app.api.agentId !== r.id) return selectAgent(r.id);
  if (app.api instanceof MockOwnerApi && r.name === "home" && demoTimer === undefined) {
    const api = app.api;
    demoTimer = window.setTimeout(() => api.demoRequest(), 6000);
  }
  const screen =
    r.name === "activity"
      ? activity()
      : r.name === "policy"
        ? policy()
        : r.name === "settings"
          ? settings()
          : r.name === "entry"
            ? detail(r.id)
            : r.name === "connect"
              ? connect()
              : r.name === "setup"
                ? agentSetup(r.id)
                : r.name === "agent"
                  ? agentEdit(r.id)
                  : home();
  // 맡길 일 상자는 홈에서만 (home()이 다시 보여 줌). 쓴 글은 남아 있다
  if (r.name !== "home" && r.name !== "req" && r.name !== "deposit") hideComposer();
  paint(screen);
  if (r.name === "deposit") {
    history.replaceState(null, "", "#/home");
    app.route = { name: "home" };
    deposit();
    return;
  }
  if (r.name === "connect" || r.name === "setup") return;
  if (r.name === "req") {
    // 알림에서 들어온 구매 요청: 홈을 깔고 그 요청 시트를 띄운다 (주소는 홈으로 바꿔 둠)
    history.replaceState(null, "", "#/home");
    app.route = { name: "home" };
    const req = app.data.requests.find((x) => x.id === r.id && x.status === "pending");
    if (req) openApproval(req);
    else pendingReq = r.id;
    return;
  }
  if (pendingReq) {
    const req = app.data.requests.find((x) => x.id === pendingReq && x.status === "pending");
    if (req) {
      pendingReq = undefined;
      openApproval(req);
      return;
    }
    if (app.data.loadedAt) pendingReq = undefined;
  }
  autoPrompt();
}

/** QR 링크(#pair=…)로 열렸으면 토큰을 꺼내고 주소창에서 바로 지운다 */
function takePairLink(): Pairing | undefined {
  if (!location.hash.includes("pair=")) return undefined;
  const p = parsePairing(location.href);
  history.replaceState(null, "", location.pathname + location.search);
  return p;
}

async function boot(): Promise<void> {
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js");
    // 열린 앱에서 알림을 누르면: 비밀번호 → 그 화면 (구매 요청이면 시트, 막은 결제면 거절 상세)
    navigator.serviceWorker.addEventListener("message", async (e: MessageEvent<{ type?: string; hash?: string }>) => {
      if (e.data?.type !== "open" || !e.data.hash || !app.api) return;
      const hash = e.data.hash;
      if (!(await unlock({ title: hash.startsWith("#/req/") ? "구매 요청을 확인해요" : "막은 결제를 확인해요", autoFace: true }))) return;
      location.hash = hash;
    });
  }
  const link = takePairLink();
  await splash();

  let pairing = FORCE_MOCK ? { base: "", token: "", label: "데모", mock: true } : store.pairing();
  // 새 QR로 열었으면 다시 매칭
  if (link && pairing && !pairing.mock && link.token !== pairing.token) pairing = undefined;

  // 처음 여는 거면(매칭이나 비밀번호 전) 브라우저에서는 홈 화면 추가 안내부터.
  // 아이폰은 Safari와 홈 화면 앱이 저장소를 따로 쓴다 → 홈 화면 앱 안에서 매칭해야 한다
  if ((!pairing || !store.hasPin()) && !isStandalone()) await installGuide({ hadPairLink: !!link });

  if (!pairing) {
    pairing = await pairScreen(link);
    store.setPairing(pairing);
    app.api = pairing.mock ? new MockOwnerApi(!location.search.includes("sample")) : new HttpOwnerApi(pairing.base, pairing.token);
    if (!store.hasPin()) await pinSetup(pairing.mock ? "데모 지갑" : pairing.label);
  } else {
    app.api = pairing.mock ? new MockOwnerApi(!location.search.includes("sample")) : new HttpOwnerApi(pairing.base, pairing.token);
    if (!store.hasPin()) await pinSetup(pairing.mock ? "데모 지갑" : pairing.label);
    else {
      void refresh();
      await unlock({ autoFace: true });
    }
  }

  app.render = render;
  app.afterRefresh = checkNotifications;
  app.route = parseHash();
  if (!location.hash) history.replaceState(null, "", "#/home");
  window.addEventListener("hashchange", () => {
    closeAllSheets();
    if (app.route.name === "connect") leaveConnect();
    app.route = parseHash();
    render();
  });
  render();
  startPolling();
  relockOnReturn();
}

/** 5분 넘게 다른 앱에 있다 돌아오면 다시 잠근다 */
function relockOnReturn(): void {
  let hiddenAt = 0;
  let locking = false;
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (!locking && hiddenAt && Date.now() - hiddenAt > 5 * 60_000) {
      locking = true;
      await unlock({ autoFace: true });
      locking = false;
    }
  });
}

void boot();
