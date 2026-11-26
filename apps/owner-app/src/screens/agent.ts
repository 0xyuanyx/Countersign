// 에이전트 편집 (AgentEdit): 에이전트 목록의 ⋯ 버튼, 설정의 에이전트 줄에서 들어온다.
// 이름, 오늘 쓴 돈, 결제 계정, 정책(에이전트마다 따로), 이 에이전트만 멈추기, 다른 앱으로 옮기기, 연결 끊기

import { ApiError } from "../api.js";
import { app, go, openSheet, refreshSoon, type Screen } from "../app.js";
import { addrHtml, esc, ic, toast, usdc } from "../ui.js";
import { agentState, attached } from "./common.js";
import { unlock } from "./gates.js";
import { showCreated } from "./onboard.js";

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;


export function agentEdit(id: string): Screen {
  const a = app.data.agents.find((x) => x.id === id);
  const p = app.data.policy;
  if (!a) {
    return {
      html: `<div class="screen">
        <div class="topbar"><a class="icon-btn" href="#/settings" aria-label="뒤로">${ic.back()}</a><span></span></div>
        <p class="muted" style="margin-top:24px">${app.data.loadedAt ? "이 에이전트를 찾지 못했어요" : "불러오는 중…"}</p></div>`,
    };
  }
  // 화면을 열 때 이 에이전트로 전환해 두므로, 정책 요약이 곧 이 에이전트 것
  const spent = Number(p?.spent_24h ?? 0);
  const acct = a.address ?? p?.account;
  const html = `
  <div class="screen">
    <div class="topbar"><button type="button" class="icon-btn" data-act="back" aria-label="뒤로">${ic.back()}</button><h1 class="t15b" style="margin:0">에이전트 편집</h1><span style="width:44px"></span></div>
    <span class="conn-chip" style="margin-top:12px;align-self:flex-start;${attached(a) && !a.paused ? "" : "opacity:0.6"}"><img src="/mark.svg" width="18" height="18" alt="">${agentState(a)}</span>

    <label class="t13 dim" for="agent-name" style="margin-top:20px">이름</label>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input id="agent-name" class="field" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40" value="${esc(a.name)}" ${a.connected ? "" : "disabled"}>
      <button type="button" class="pill" data-act="rename" style="height:52px;flex:none;display:none">저장</button>
    </div>
    <p class="err-text" style="margin-top:6px;min-height:18px" role="alert"></p>

    <section class="card" style="margin-top:4px;padding:0 16px">
      <div class="list-row" style="min-height:56px;justify-content:space-between"><span class="t15">오늘 쓴 돈</span><span class="muted t15">${spent.toFixed(2)} <span class="dim">/ ${usdc(p?.daily_max)} USDC</span></span></div>
      <div class="divider"></div>
      <div class="list-row" style="min-height:56px;justify-content:space-between"><span class="t15">결제 계정${a.account_index !== undefined ? ` <span class="dim t12">${a.account_index}번</span>` : ""}</span>${acct ? addrHtml(acct, { short: true }) : '<span class="dim">—</span>'}</div>
      <div class="divider"></div>
      <a class="list-row press" href="#/policy" style="min-height:56px;justify-content:space-between"><span class="t15">이 에이전트의 정책</span><span class="muted t15" style="display:flex;align-items:center;gap:6px">1회 ${usdc(p?.per_tx_max)} · 하루 ${usdc(p?.daily_max)}${ic.chevR()}</span></a>
    </section>

    ${
      a.connected
        ? `<section class="card" style="margin-top:12px;padding:0 16px">
      <button type="button" class="list-row" data-act="pause" style="width:100%;text-align:left;min-height:64px;justify-content:space-between">
        <span class="stack"><span class="t15">이 에이전트만 멈추기</span><span class="dim t12">다른 에이전트는 계속 결제해요</span></span>
        <span class="switch ${a.paused ? "on" : ""}" role="switch" aria-checked="${a.paused ? "true" : "false"}"><span></span></span>
      </button>
      <div class="divider"></div>
      <button type="button" class="list-row" data-act="move" style="width:100%;text-align:left;min-height:64px;justify-content:space-between">
        <span class="stack"><span class="t15">다른 앱으로 옮기기</span><span class="dim t12">새 연결 주소를 만들면 지금 주소는 바로 끊겨요</span></span>${ic.chevR()}
      </button>
    </section>
    <button type="button" class="list-row" data-act="disconnect" style="width:100%;min-height:56px;margin-top:12px;color:var(--bad);justify-content:center">연결 끊기</button>
    <p class="dim t12" style="text-align:center;line-height:18px">끊어도 결제 계정과 내역은 남아요. 남은 돈은 그대로예요</p>`
        : `<p class="dim t13" style="margin-top:16px;line-height:20px">연결이 끊긴 에이전트예요. 내역은 남아 있어요</p>`
    }
  </div>`;

  return {
    html,
    bind: (root) => {
      const input = root.querySelector<HTMLInputElement>("#agent-name")!;
      const save = root.querySelector<HTMLButtonElement>('[data-act="rename"]')!;
      const err = root.querySelector<HTMLElement>(".err-text")!;
      input.addEventListener("input", () => {
        save.style.display = input.value.trim() === a.name ? "none" : "";
        err.textContent = "";
      });
      root.addEventListener("click", async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
        const act = btn?.dataset.act;
        if (act === "rename") {
          const name = input.value.trim();
          if (!NAME_RE.test(name)) return void (err.textContent = "영문·숫자·-·_로 40자까지 넣어 주세요");
          btn!.disabled = true;
          try {
            await app.api.renameAgent(a.id, name);
            toast("이름을 바꿨어요");
            refreshSoon();
          } catch (x) {
            err.textContent = x instanceof ApiError ? x.message : "바꾸지 못했어요";
          }
          btn!.disabled = false;
        }
        if (act === "pause") {
          const next = !a.paused;
          // 멈추는 건 바로, 다시 켜는 건 비밀번호 (긴급 정지와 같은 규칙)
          if (!next && !(await unlock({ title: `${a.name} 다시 켜요`, subtitle: "정책 안에서 다시 결제할 수 있어요", closable: true }))) return;
          try {
            await app.api.pauseAgent(a.id, next);
            toast(next ? "이 에이전트만 멈췄어요" : "다시 켰어요");
            refreshSoon();
          } catch (x) {
            toast(x instanceof ApiError ? x.message : "바꾸지 못했어요");
          }
        }
        if (act === "back") history.length > 1 ? history.back() : go("settings");
        if (act === "move") moveSheet(a.id, a.name);
        if (act === "disconnect") disconnectSheet(a.id, a.name);
      });
    },
  };
}

function moveSheet(id: string, name: string): void {
  openSheet(
    `<h1 class="title-md">다른 앱으로 옮길까요</h1>
     <p class="muted" style="margin-top:8px;line-height:22px;font-size:14px">새 연결 주소를 만들어요 · 지금 주소를 넣은 앱은 바로 끊기고, 이름과 내역은 그대로예요</p>
     <div class="bottom-actions" style="padding-top:20px">
       <button class="btn btn-primary press" data-act="go">새 주소 만들기</button>
       <button class="btn btn-ghost press" data-act="cancel">취소</button>
     </div>`,
    (sheet, close) =>
      sheet.addEventListener("click", async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "cancel") return void close();
        if (act !== "go") return;
        await close();
        if (!(await unlock({ title: "새 연결 주소를 만들어요", subtitle: "지금 주소는 바로 끊겨요", closable: true }))) return;
        try {
          await app.api.disconnectAgent(id);
          showCreated(await app.api.createAgent(name));
          refreshSoon();
          go("connect");
        } catch (x) {
          toast(x instanceof ApiError ? x.message : "옮기지 못했어요");
          refreshSoon();
        }
      }),
    { label: "다른 앱으로 옮기기" },
  );
}

function disconnectSheet(id: string, name: string): void {
  openSheet(
    `<h1 class="title-md">${esc(name)} 연결을 끊을까요</h1>
     <p class="muted" style="margin-top:8px;line-height:22px;font-size:14px">이 주소로는 더 결제할 수 없어요 · 결제 계정과 내역은 남고, 남은 돈도 그대로예요</p>
     <div class="bottom-actions" style="padding-top:20px">
       <button class="btn btn-danger press" data-act="go">연결 끊기</button>
       <button class="btn btn-ghost press" data-act="cancel">취소</button>
     </div>`,
    (sheet, close) =>
      sheet.addEventListener("click", async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "cancel") return void close();
        if (act !== "go") return;
        await close();
        if (!(await unlock({ title: "연결을 끊어요", subtitle: name, closable: true }))) return;
        try {
          await app.api.disconnectAgent(id);
          toast("연결을 끊었어요");
          refreshSoon();
        } catch (x) {
          toast(x instanceof ApiError ? x.message : "끊지 못했어요");
        }
      }),
    { label: "연결 끊기" },
  );
}
