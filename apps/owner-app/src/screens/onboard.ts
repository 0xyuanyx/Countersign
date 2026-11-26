// 처음 연결 흐름 (design/README.md "2026-11-26 추가")
// 처음 홈(HomeEmpty): 에이전트 연결 → 기본 규칙 → USDC 넣기. 세 단계를 다 마치면 일반 홈.
// 연결 화면(Connect) → 에이전트 앱에 붙이면 기본 규칙(AgentSetup) → 비밀번호 → 홈. 기본 규칙 전에는 맡길 일 입력칸이 잠김.

import { ApiError, chainIds, type NewAgent } from "../api.js";
import { app, go, refreshSoon, type Screen } from "../app.js";
import { esc, ic, toast, usdc } from "../ui.js";
import { agentState, attached, chainName, tabs } from "./common.js";
import { MockOwnerApi } from "../mock.js";
import { unlock } from "./gates.js";

const SETUP_KEY = "cs.setupDone";

function setupIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SETUP_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function markSetup(id: string): void {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify([...new Set([...setupIds(), id])]));
  } catch {
    /* 저장 못 해도 결제 기록이 생기면 끝난 걸로 본다 */
  }
}

/** 기본 규칙을 마쳤는지: 이 폰에서 마쳤거나, 이미 결제 기록·활동이 있는 지갑이면 마친 걸로 본다 */
export function setupDone(): boolean {
  const ids = setupIds();
  const live = app.data.agents.filter((a) => a.connected);
  return live.some((a) => ids.includes(a.id) || a.last_activity_at !== undefined) || app.data.history.length > 0;
}

export type StartSteps = { agent: boolean; rules: boolean; funds: boolean };
export function startSteps(): StartSteps {
  const bal = app.data.balance?.balances.find((b) => b.balance !== undefined)?.balance;
  return {
    agent: app.data.agents.some((a) => a.connected),
    rules: setupDone(),
    // 잔액을 못 읽으면(signer 꺼짐) 막지 않는다
    funds: bal === undefined ? app.data.balance !== undefined : Number(bal) > 0,
  };
}
/** 세 단계를 다 마치기 전이면 처음 홈 */
export function isFresh(): boolean {
  if (!app.data.loadedAt && !app.data.okAt) return false;
  const s = startSteps();
  return !(s.agent && s.rules && s.funds);
}

// ─── 처음 홈 ───
export function homeEmpty(): Screen {
  const s = startSteps();
  const done = [s.agent, s.rules, s.funds].filter(Boolean).length;
  const bal = app.data.balance?.balances.find((b) => b.balance !== undefined)?.balance;
  const newestAgent = app.data.agents.filter((a) => a.connected).at(-1);
  const step = (n: number, ok: boolean, title: string, sub: string, href?: string, primary = false) => {
    const inner = `<span class="step-n ${ok ? "ok" : primary ? "now" : ""}">${ok ? ic.check(14, "#0E0E10") : n}</span>
      <span class="stack"><span class="t15" style="font-weight:500;${ok ? "color:var(--fg3);text-decoration:line-through" : ""}">${title}</span><span class="dim t13">${sub}</span></span>
      ${href && !ok ? ic.chevR() : ""}`;
    return `<li>${href && !ok ? `<a href="${href}" class="start-step press ${primary ? "primary" : ""}">${inner}</a>` : `<div class="start-step">${inner}</div>`}</li>`;
  };
  const html = `
  <div class="screen with-tabs with-input">
    <div class="topbar">
      <span style="display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600"><img src="/mark.svg" width="28" height="28" alt="">Countersign</span>
      <span class="chip-net">${esc(chainName(chainIds(app.data.policy)[0]) || "—")}${app.api.mock ? " · 데모" : ""}</span>
    </div>
    <h1 class="title-md" style="margin-top:28px;font-size:26px;line-height:1.3">에이전트를 연결하면<br>지갑이 결제를 지켜봐요</h1>
    <p class="muted" style="margin-top:10px">${done} / 3 · 세 단계면 시작할 수 있어요</p>
    <ol class="start-steps">
      ${step(1, s.agent, "에이전트 연결하기", "Claude, Codex, Cursor에 주소 한 줄", "#/connect", !s.agent)}
      ${step(2, s.rules, "기본 규칙 정하기", s.agent ? "한도와 판매자 규칙" : "한도와 판매자 · 연결하면 바로 이어져요", s.agent && newestAgent ? `#/setup/${newestAgent.id}` : undefined, s.agent && !s.rules)}
      ${step(3, s.funds, "USDC 넣기", `지금 잔액 ${bal !== undefined ? usdc(bal) : "-.--"} · 먼저 넣어도 돼요`, "#/deposit", s.agent && s.rules)}
    </ol>
  </div>
  <div class="cmd-input"><div aria-disabled="true">${ic.lock(18)}<span class="dim" style="flex:1;font-size:15px">${s.agent ? "기본 규칙을 정하면 일을 맡길 수 있어요" : "에이전트를 연결하면 일을 맡길 수 있어요"}</span></div></div>
  ${tabs("home")}`;
  return { html };
}

// ─── 에이전트 연결 (새 연결 주소 만들기) ───
let created: NewAgent | undefined;

export function connect(): Screen {
  const n = app.data.agents.length + 1;
  const cmd = (label: string, value: string, hint: string) => `
    <div class="inner" style="gap:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="t15b">${label}</span>
        <button type="button" class="pill" style="height:36px" data-copy="${esc(value)}">복사</button></div>
      <span class="mono t12 muted" style="word-break:break-all">${esc(value)}</span>
      <span class="dim t12">${hint}</span>
    </div>`;
  const html = created
    ? `
    <div class="screen">
      <div class="topbar"><a class="icon-btn" href="#/home" aria-label="닫기">${ic.close()}</a><span class="t13 dim">${setupDone() ? "" : "1 / 3"}</span></div>
      <span class="conn-chip" style="margin-top:12px;align-self:flex-start"><span class="dot"></span>${esc(created.name)} 연결 주소를 만들었어요</span>
      <h1 class="title-md" style="margin-top:16px">에이전트 앱에 이 주소를 넣어 주세요</h1>
      <p class="muted t13" style="margin-top:8px;line-height:20px">여기서 한 번만 보여 줘요 · 이 주소는 비밀번호와 같아서, 잃어버리면 연결을 끊고 새로 만들면 돼요</p>
      ${app.api.mock ? `<div class="banner ask" role="note" style="margin-top:16px"><span class="dot ask"></span><span class="stack"><span class="t14">데모라 실제 에이전트는 붙지 않아요</span><span class="dim t12">"붙였어요, 다음"을 누르면 에이전트가 붙은 것처럼 이어가요</span></span></div>` : ""}
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px">
        ${cmd("Claude 앱", created.connect.claude_connector, "설정 › 커넥터 › 사용자 지정 커넥터에 붙여 넣기")}
        ${cmd("Claude Code", created.connect.claude_code, "터미널에 붙여 넣기")}
        ${cmd("Codex", created.connect.codex, "터미널에 붙여 넣기")}
        <a class="inner press" style="flex-direction:row;align-items:center;justify-content:space-between" href="${esc(created.connect.cursor)}"><span class="t15b">Cursor에서 열기</span>${ic.chevR()}</a>
      </div>
      <div class="bottom-actions"><button class="btn btn-primary press" data-act="next">붙였어요, 다음</button></div>
    </div>`
    : `
    <div class="screen">
      <div class="topbar"><a class="icon-btn" href="#/home" aria-label="닫기">${ic.close()}</a><span class="t13 dim">${setupDone() ? "" : "1 / 3"}</span></div>
      <h1 class="title-md" style="margin-top:20px">에이전트 연결하기</h1>
      <p class="muted" style="margin-top:8px;line-height:22px;font-size:14px">에이전트마다 연결 주소가 하나씩 생겨요. 주소를 넣은 앱(Claude, Codex, Cursor)이 이 지갑으로 결제를 요청해요. 키는 지갑 서버에만 있어요</p>
      <label class="t13 dim" for="agent-name" style="margin-top:24px">에이전트 이름 (영문·숫자·-·_)</label>
      <input id="agent-name" class="field" style="margin-top:8px" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40" value="agent-${n}">
      <p class="err-text" style="margin-top:8px;min-height:20px" role="alert"></p>
      <div class="bottom-actions"><button class="btn btn-primary press" data-act="create">연결 주소 만들기</button></div>
    </div>`;
  return {
    html,
    bind: (root) => {
      root.addEventListener("click", async (e) => {
        const t = e.target as HTMLElement;
        const copy = t.closest<HTMLElement>("[data-copy]");
        if (copy) {
          await navigator.clipboard?.writeText(copy.dataset.copy!).catch(() => {});
          toast("복사했어요");
          return;
        }
        const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "create") {
          const input = root.querySelector<HTMLInputElement>("#agent-name")!;
          const err = root.querySelector<HTMLElement>(".err-text")!;
          const name = input.value.trim();
          if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) {
            err.textContent = "영문·숫자·-·_로 40자까지 넣어 주세요";
            return;
          }
          (t.closest("button") as HTMLButtonElement).disabled = true;
          try {
            created = await app.api.createAgent(name);
            refreshSoon();
            app.render();
          } catch (x) {
            err.textContent = x instanceof ApiError ? x.message : "만들지 못했어요";
            (t.closest("button") as HTMLButtonElement).disabled = false;
          }
        }
        if (act === "next" && created) {
          const id = created.id;
          created = undefined; // 토큰이 든 주소는 화면을 떠나면 다시 보여 주지 않는다
          if (app.api instanceof MockOwnerApi) {
            app.api.demoAttach(id);
            refreshSoon();
          }
          if (setupDone()) {
            // 기본 규칙은 지갑 하나에 하나라, 두 번째 에이전트부터는 바로 홈으로
            toast("연결했어요. 기본 규칙은 그대로 따라요");
            go("home");
          } else go(`setup/${id}`);
        }
      });
    },
  };
}

/** 에이전트 편집의 "다른 앱으로 옮기기": 새로 만든 연결 주소를 연결 화면에 띄운다 */
export function showCreated(n: NewAgent): void {
  created = n;
}

/** 연결 화면을 떠나면 토큰 주소를 메모리에서도 지운다 */
export function leaveConnect(): void {
  created = undefined;
}

// ─── 연결 직후 기본 규칙 ───
export function agentSetup(id: string): Screen {
  const a = app.data.agents.find((x) => x.id === id);
  const p = app.data.policy;
  const per = usdc(p?.per_tx_max ?? "0.5");
  const daily = usdc(p?.daily_max ?? "5");
  const net = chainName(chainIds(p)[0]) || "HSK 테스트넷";
  const limitRow = (key: string, label: string, sub: string, v: string) => `
    <label class="limit-row" for="lim-${key}">
      <span class="stack"><span class="t15" style="font-weight:500">${label}</span><span class="dim t12">${sub}</span></span>
      <span style="display:flex;align-items:center;gap:6px;flex:none"><input id="lim-${key}" class="field mini" inputmode="decimal" autocomplete="off" value="${v}" data-lim="${key}"><span class="muted t13">USDC</span></span>
    </label>`;
  const rule = (color: string, html: string) => `<div style="display:flex;gap:10px;align-items:flex-start"><span class="dot" style="background:${color};margin-top:7px"></span><span class="muted t13" style="line-height:20px">${html}</span></div>`;
  const html = `
  <div class="screen">
    <div class="topbar"><span></span><span class="t13 dim">2 / 3</span></div>
    <span class="conn-chip" style="margin-top:12px;align-self:flex-start"><img src="/mark.svg" width="18" height="18" alt="" style="${a && attached(a) ? "" : "opacity:0.4"}">${esc(a?.name ?? "에이전트")} ${a ? agentState(a) : "연결 기다리는 중"}${app.api.mock ? " · 데모" : ""}</span>
    <h1 class="title-md" style="margin-top:16px;font-size:26px;line-height:1.3">일을 맡기기 전에<br>기본 규칙을 정해요</h1>
    <p class="muted" style="margin-top:8px;font-size:14px">나중에 정책 탭에서 언제든 바꿀 수 있어요</p>
    <section class="card" style="margin-top:20px;padding:4px 16px">
      ${limitRow("per", "1회 최대", "결제 한 번에 이만큼까지", per)}
      <div class="divider"></div>
      ${limitRow("daily", "하루 최대", "자정에 다시 채워져요", daily)}
    </section>
    <p class="err-text" style="margin-top:8px;min-height:20px" role="alert"></p>
    <section class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
      ${rule("var(--ask)", `<b style="color:var(--fg);font-weight:500">처음 보는 판매자</b>는 결제 전에 폰으로 물어봐요. 승인하면 다음부터 바로 결제해요`)}
      ${rule("var(--bad)", `<b style="color:var(--fg);font-weight:500">등록한 판매자 이름으로 다른 주소</b>가 오면 묻지 않고 거절해요`)}
      ${rule("var(--ok)", `${esc(net)}의 <b style="color:var(--fg);font-weight:500">USDC</b>만 써요`)}
    </section>
    <div class="bottom-actions">
      <button class="btn btn-primary press" data-act="start">이대로 시작</button>
      <span class="dim t12" style="text-align:center;margin-top:8px">저장할 때 비밀번호로 한 번 확인해요</span>
    </div>
  </div>`;
  return {
    html,
    bind: (root) =>
      root.querySelector('[data-act="start"]')!.addEventListener("click", async () => {
        const err = root.querySelector<HTMLElement>(".err-text")!;
        const v = (k: string) => root.querySelector<HTMLInputElement>(`[data-lim="${k}"]`)!.value.trim();
        const nPer = v("per");
        const nDaily = v("daily");
        const ok = (x: string) => /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(x) && Number(x) > 0;
        if (!ok(nPer) || !ok(nDaily)) return void (err.textContent = "0보다 큰 숫자를 넣어 주세요 (소수 6자리까지)");
        if (Number(nPer) > Number(nDaily)) return void (err.textContent = "1회 최대는 하루 최대보다 클 수 없어요");
        err.textContent = "";
        if (!(await unlock({ title: "비밀번호를 입력해 주세요", subtitle: `기본 규칙을 저장해요 · 1회 ${usdc(nPer)} · 하루 ${usdc(nDaily)}`, closable: true }))) return;
        try {
          const body: { perTxMax?: string; dailyMax?: string } = {};
          if (Number(nPer) !== Number(p?.per_tx_max)) body.perTxMax = nPer;
          if (Number(nDaily) !== Number(p?.daily_max)) body.dailyMax = nDaily;
          if (body.perTxMax || body.dailyMax) await app.api.patchPolicy(body);
          markSetup(id);
          toast("기본 규칙을 저장했어요");
          refreshSoon();
          go("home");
        } catch (x) {
          err.textContent = x instanceof ApiError ? x.message : "저장하지 못했어요";
        }
      }),
  };
}
