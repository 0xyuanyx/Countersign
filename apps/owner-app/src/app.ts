// 앱 상태·주기적 새로고침·화면 전환·시트. 화면은 screens/*.ts가 HTML 문자열로 그린다.

import { ApiError, type Agent, type Balance, type Check, type HistoryEntry, type OwnerApi, type PolicySummary, type PurchaseRequest, type Task } from "./api.js";
import { esc, transition } from "./ui.js";

export type Data = {
  policy?: PolicySummary;
  balance?: Balance;
  history: HistoryEntry[];
  requests: PurchaseRequest[];
  tasks: Task[];
  agents: Agent[];
  /** 지갑 서버에 못 닿으면 메시지 */
  offline?: string;
  /** 주인 토큰이 거절됨(401): 서버에서 토큰을 바꿨으니 다시 매칭해야 한다 */
  authFailed?: boolean;
  loadedAt?: number;
  /** 마지막으로 서버에 닿은 시각 (ms) */
  okAt?: number;
};

export type Route =
  | { name: "home" }
  | { name: "activity" }
  | { name: "policy" }
  | { name: "settings" }
  | { name: "entry"; id: string }
  /** 알림에서 들어온 구매 요청: 홈 위에 구매 요청 시트 */
  | { name: "req"; id: string }
  | { name: "connect" }
  | { name: "setup"; id: string }
  /** 에이전트 편집 */
  | { name: "agent"; id: string }
  /** 처음 홈의 "USDC 넣기": 홈 위에 입금 시트 */
  | { name: "deposit" };

export type Screen = {
  html: string;
  /** 그린 뒤 한 번 (이벤트 연결) */
  bind?: (root: HTMLElement) => void;
};

export const app = {
  api: undefined as unknown as OwnerApi,
  data: { history: [], requests: [], tasks: [], agents: [] } as Data,
  route: { name: "home" } as Route,
  /** 이미 한 번 움직임을 보여 준 것 (다시 그릴 때 또 움직이지 않게) */
  animated: new Set<string>(),
  /** 이번 실행에서 자동으로 띄운 구매 요청 */
  prompted: new Set<string>(),
  render: () => {},
  /** 내역 화면을 열 때 펼치고 보여 줄 맡긴 일 (홈 상태 줄에서 누름) */
  focusTask: undefined as string | undefined,
  /** 새로고침이 끝날 때마다 (알림 확인) */
  afterRefresh: () => {},
};

const ROUTES: Record<string, Route["name"]> = {
  "": "home",
  home: "home",
  activity: "activity",
  policy: "policy",
  settings: "settings",
  connect: "connect",
  deposit: "deposit",
};

export function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const m = /^p\/([A-Za-z0-9_\-]+)$/.exec(h);
  if (m) return { name: "entry", id: m[1]! };
  const r = /^req\/([A-Za-z0-9_\-]+)$/.exec(h);
  if (r) return { name: "req", id: r[1]! };
  const su = /^setup\/([A-Za-z0-9_\-]+)$/.exec(h);
  if (su) return { name: "setup", id: su[1]! };
  const ag = /^agent\/([A-Za-z0-9_\-]+)$/.exec(h);
  if (ag) return { name: "agent", id: ag[1]! };
  return { name: ROUTES[h] ?? "home" } as Route;
}

export function go(path: string): void {
  if (location.hash === `#/${path}`) return;
  location.hash = `#/${path}`;
}

// ─── 새로고침 ───
let timer: number | undefined;
let hiddenTick = 0;
let fast = 0;

// ─── 숨긴 에이전트 (지갑 서버가 숨김을 저장하지 못할 때 이 폰에만) ───
const HIDDEN_KEY = "cs.hiddenAgents";
function hiddenHere(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
export function hideHere(id: string): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...new Set([...hiddenHere(), id])]));
  } catch {
    /* 저장 못 하면 다음에 다시 보인다 */
  }
}
/** 연결 끊은 에이전트 (숨긴 것 빼고) */
export function goneAgents(): Agent[] {
  return app.data.agents.filter((a) => !a.connected);
}

// ─── 지금 보고 있는 에이전트 ───
const AGENT_KEY = "cs.agent";
function savedAgent(): string | undefined {
  try {
    return localStorage.getItem(AGENT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
/** 고른 에이전트가 없거나 사라졌으면: 실제로 붙은 것 → 연결된 것 → 아무거나 (최근 것 먼저) */
function pickAgent(list: Agent[], want?: string): string | undefined {
  if (want && list.some((x) => x.id === want)) return want;
  const seen = (x: Agent) => x.last_seen_at ?? x.last_activity_at ?? x.attached_at ?? 0;
  const by = [...list].sort((x, y) => seen(y) - seen(x));
  return (by.find((x) => x.connected && seen(x) > 0) ?? by.find((x) => x.connected) ?? by[0])?.id;
}
export function currentAgent(): Agent | undefined {
  return app.data.agents.find((x) => x.id === app.api?.agentId);
}
/** 다른 에이전트로 전환: 그 에이전트의 잔액·한도·내역으로 화면을 다시 채운다 */
export function selectAgent(id: string): void {
  if (app.api.agentId === id) return;
  try {
    localStorage.setItem(AGENT_KEY, id);
  } catch {
    /* 저장 못 해도 이번 실행에서는 바뀐다 */
  }
  app.api.agentId = id;
  app.data = { history: [], requests: [], tasks: [], agents: app.data.agents };
  lastBalanceFor = undefined;
  app.render();
  refreshSoon();
}
let lastBalanceFor: string | undefined;

export async function refresh(): Promise<void> {
  const a = app.api;
  try {
    const hidden = hiddenHere();
    const agents = (await a.agents().catch(() => [] as Agent[])).filter((x) => !x.hidden && !hidden.includes(x.id));
    const id = pickAgent(agents, a.agentId ?? savedAgent());
    if (id !== a.agentId) {
      a.agentId = id;
      app.data = { ...app.data, history: [], requests: [], tasks: [], policy: undefined, balance: undefined };
    }
    const [policy, history, requests, tasks] = await Promise.all([
      a.policy(),
      a.history(100),
      a.requests("pending"),
      a.tasks().catch(() => [] as Task[]),
    ]);
    // 잔액은 RPC를 거쳐 느리니 15초마다
    const now = Date.now();
    let balance = lastBalanceFor === a.agentId ? app.data.balance : undefined;
    lastBalanceFor = a.agentId;
    if (!balance || !app.data.loadedAt || now - app.data.loadedAt > 15_000 || fast > 0) balance = await a.balance().catch(() => balance);
    const next: Data = { policy, balance, history, requests, tasks, agents, loadedAt: balance === app.data.balance ? app.data.loadedAt : now, okAt: now };
    const changed = JSON.stringify({ ...next, loadedAt: 0, okAt: 0 }) !== JSON.stringify({ ...app.data, loadedAt: 0, okAt: 0 });
    app.data = next;
    if (changed) app.render();
    app.afterRefresh();
  } catch (e) {
    const authFailed = e instanceof ApiError && e.status === 401;
    const msg = authFailed ? "주인 토큰이 바뀌었어요" : e instanceof Error ? e.message : "지갑 서버에 닿지 않아요";
    if (app.data.offline !== msg) {
      app.data = { ...app.data, offline: msg, authFailed };
      app.render();
    }
  }
}

/** 화면이 보일 때 3초마다 (방금 무언가를 했으면 1초마다 몇 번). 가려져 있으면 알림 확인용으로 15초마다 */
export function startPolling(): void {
  const loop = async () => {
    const visible = document.visibilityState === "visible";
    if (visible || hiddenTick++ % 5 === 0) await refresh();
    if (visible) hiddenTick = 0;
    fast = Math.max(0, fast - 1);
    timer = window.setTimeout(loop, fast > 0 ? 1000 : 3000);
  };
  clearTimeout(timer);
  void loop();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      clearTimeout(timer);
      void loop();
    }
  });
}
export function refreshSoon(): void {
  fast = 6;
  clearTimeout(timer);
  startPolling();
}

// ─── 대조 띠 ───
const FIELDS: { key: string; label: string }[] = [
  { key: "payee", label: "수취인" },
  { key: "amount", label: "금액" },
  { key: "chain", label: "체인" },
  { key: "token", label: "토큰" },
  { key: "expiry", label: "만료" },
  { key: "signer", label: "서명자" },
];
export const FIELD_LABEL: Record<string, string> = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));

/**
 * 초록 = 됨, 빨강 = 안 됨(그 뒤는 회색), 주황 = 사람에게 묻는 중(다른 검사 칸은 초록), 회색 = 아직 안 함.
 * checks가 없으면: 결제됨은 모두 초록, 나머지는 모두 회색.
 */
export function stripCells(e: Pick<HistoryEntry, "status" | "checks">): { key: string; label: string; cls: string }[] {
  const by = new Map((e.checks ?? []).map((c) => [c.field, c]));
  let stopped = false;
  return FIELDS.map((f) => {
    const c: Check | undefined = by.get(f.key);
    let cls = "idle";
    if (stopped) cls = "idle";
    else if (c?.result === "match") cls = "match";
    else if (c?.result === "mismatch") {
      cls = "mismatch";
      stopped = true;
    } else if (c?.result === "needs_approval") cls = "ask";
    else if (!e.checks && e.status === "paid") cls = "match";
    return { key: f.key, label: c?.result === "needs_approval" ? "처음 봄" : f.label, cls };
  });
}

export function strip(e: Pick<HistoryEntry, "status" | "checks">, opts: { size?: "sm" | "lg" | "mini"; animate?: boolean } = {}): string {
  const cells = stripCells(e);
  const size = opts.size ?? "sm";
  const label = cells.map((c) => `${c.label} ${{ match: "맞음", mismatch: "다름", ask: "확인 필요", idle: "검사 안 함" }[c.cls]}`).join(", ");
  return `<div class="strip ${size === "sm" ? "" : size} ${opts.animate ? "animate" : ""}" role="img" aria-label="${esc(label)}">${cells
    .map((c, i) => `<div class="cell ${c.cls}" style="--i:${i}"><span class="bar"></span>${size === "mini" ? "" : `<span class="lbl">${esc(c.label)}</span>`}</div>`)
    .join("")}</div>`;
}

// ─── 시트 ───
export function openSheet(html: string, bind?: (sheet: HTMLElement, close: () => Promise<void>) => void, opts: { label?: string; dismissable?: boolean } = {}): () => Promise<void> {
  const host = document.getElementById("sheet-root")!;
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  if (opts.label) sheet.setAttribute("aria-label", opts.label);
  sheet.innerHTML = `<span class="grabber"></span>${html}`;
  host.append(scrim, sheet);
  let closed = false;
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      scrim.classList.add("closing");
      sheet.classList.add("closing");
      setTimeout(() => {
        scrim.remove();
        sheet.remove();
        resolve();
      }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240);
    });
  if (opts.dismissable !== false) scrim.addEventListener("click", () => void close());
  bind?.(sheet, close);
  return close;
}

export function closeAllSheets(): void {
  document.getElementById("sheet-root")!.innerHTML = "";
}

// ─── 화면 그리기 (열린 <details>와 스크롤 위치는 지킨다) ───
let lastRouteKey = "";
export function paint(screen: Screen): void {
  const root = document.getElementById("app")!;
  const key = JSON.stringify(app.route);
  const sameRoute = key === lastRouteKey;
  const open = new Set<string>();
  const closedKeys = new Set<string>();
  if (sameRoute) {
    root.querySelectorAll<HTMLDetailsElement>("details[data-k]").forEach((d) => (d.open ? open : closedKeys).add(d.dataset.k!));
  }
  const y = window.scrollY;
  const apply = () => {
    // 화면마다 bind가 #app에 이벤트를 다는데, 같은 요소를 다시 쓰면 다시 그릴 때마다 쌓여서
    // 한 번 눌러도 시트가 여러 장 뜬다 → 그릴 때마다 새 #app으로 바꾼다
    const fresh = root.cloneNode(false) as HTMLElement;
    fresh.innerHTML = screen.html;
    root.replaceWith(fresh);
    fresh.querySelectorAll<HTMLDetailsElement>("details[data-k]").forEach((d) => {
      if (open.has(d.dataset.k!)) d.open = true;
      if (closedKeys.has(d.dataset.k!)) d.open = false;
    });
    screen.bind?.(fresh);
    if (sameRoute) window.scrollTo(0, y);
    else window.scrollTo(0, 0);
  };
  if (!sameRoute && lastRouteKey) transition(apply);
  else apply();
  lastRouteKey = key;
}
