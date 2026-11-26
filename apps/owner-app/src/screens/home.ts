// 홈: 상태, 잔액, 오늘 한도, 입금·긴급 정지, 구매 요청, 방금 막은 결제, 최근 결제, 맡길 일 입력칸

import { addressUrl, ApiError, chainIds, txUrl, type Agent, type HistoryEntry, type Task } from "../api.js";
import { app, currentAgent, goneAgents, go, openSheet, refresh, refreshSoon, selectAgent, strip, type Screen } from "../app.js";
import { store } from "../auth.js";
import { addrHtml, busy, countTo, esc, hhmm, ic, toast, usdc } from "../ui.js";
import { openApproval } from "./approval.js";
import { agentState, attached, chainName, chainShort, entryTitle, shortReason, statusWord, tabs } from "./common.js";
import { unlock } from "./gates.js";
import { homeEmpty, isFresh, setupDone } from "./onboard.js";
import { hideComposer, showComposer } from "../composer.js";
import { MockOwnerApi } from "../mock.js";

const RECENT_BLOCK_SEC = 60 * 60;
let lastBalance: number | undefined;
let lastSpent: number | undefined;

/** "방금 막은 결제": 한 시간 안의 거절 중 아직 안 열어 본 가장 최근 것 */
export function justBlocked(): HistoryEntry | undefined {
  const now = Date.now() / 1000;
  const seen = store.seen();
  return app.data.history.find((e) => e.status === "rejected" && e.code !== "OWNER_REJECTED" && now - e.at < RECENT_BLOCK_SEC && !seen.includes(e.id));
}

export function home(): Screen {
  if (isFresh()) {
    hideComposer();
    return homeEmpty();
  }
  const d = app.data;
  const p = d.policy;
  const paused = p?.paused ?? false;
  const connected = d.agents.filter((a) => a.connected);
  const me = currentAgent();
  const agentName = me?.name ?? p?.agent ?? "에이전트";
  const others = d.agents.filter((a) => a.connected && a.id !== me?.id).length;
  const bal = d.balance?.balances.find((b) => b.balance !== undefined);
  const balNum = bal?.balance !== undefined ? Number(bal.balance) : undefined;
  const spent = Number(p?.spent_24h ?? 0);
  const daily = Number(p?.daily_max ?? 0);
  const ratio = daily > 0 ? Math.min(1, spent / daily) : 0;
  const blocked = justBlocked();
  const pending = d.requests.filter((r) => r.status === "pending");
  const recent = d.history.filter((e) => e.id !== blocked?.id && e.status !== "pending").slice(0, 3);
  const gone = !!me && !me.connected;
  const runnerOff = !app.api.mock && !me?.connected;
  const needsRules = !setupDone();
  const lowBalance = balNum !== undefined && p !== undefined && balNum < Number(p.per_tx_max);

  // 홈 상태 줄: 문제가 있을 때만 "지켜보는 중" 자리에 한 줄. 여러 개면 가장 급한 것 하나 (끊김 > 잔액 부족 > 에이전트 꺼짐)
  let banner = "";
  if (d.offline) {
    const mins = d.okAt ? Math.floor((Date.now() - d.okAt) / 60_000) : undefined;
    banner = `<div class="banner bad" role="status"><span class="dot bad"></span>
      <span class="stack"><span class="t14">지갑 서버와 연결이 끊겼어요</span><span class="dim t12">${mins === undefined ? "" : mins < 1 ? "방금 전 마지막 확인 · " : `${mins}분 전 마지막 확인 · `}에이전트 결제도 멈춰 있어요</span></span>
      <button type="button" class="banner-act" data-act="retry">다시 시도</button></div>`;
  } else if (gone) {
    banner = `<div class="banner" role="status"><span class="dot off"></span>
      <span class="stack"><span class="t14">연결 끊은 에이전트예요</span><span class="dim t12">잔액 출금과 내역 보기만 돼요${balNum ? " · 남은 돈은 출금해 주세요" : ""}</span></span>
      ${balNum ? '<button type="button" class="banner-act" data-act="withdraw">출금</button>' : ""}</div>`;
  } else if (!paused && lowBalance) {
    banner = `<button type="button" class="banner ask" role="status" data-act="deposit"><span class="dot ask"></span>
      <span class="stack" style="text-align:left"><span class="t14">잔액이 ${balNum!.toFixed(2)} USDC 남았어요</span><span class="dim t12">1회 한도 ${usdc(p!.per_tx_max)}보다 적어서 결제가 막힐 수 있어요</span></span>
      <span class="banner-act">입금</span></button>`;
  } else if (!paused && runnerOff) {
    banner = `<div class="banner" role="status"><span class="dot off"></span>
      <span class="stack"><span class="t14">${esc(agentName)} 연결이 끊겼어요</span><span class="dim t12">맡길 일 입력칸이 잠겨요 · 에이전트를 바꾸거나 다시 연결하면 풀려요</span></span></div>`;
  }

  const blockedCard = blocked
    ? `<a href="#/p/${esc(blocked.id)}" class="alert-card press ${app.animated.has(`card:${blocked.id}`) ? "" : "appear"}" data-seen="${esc(blocked.id)}">
        <div class="alert-head">
          <span class="round-ic bad">${ic.blocked()}</span>
          <div class="stack"><span class="t15b">방금 결제 1건을 막았어요</span><span class="muted t13 ellipsis">${esc(blocked.seller ?? "")} · ${esc(shortReason(blocked))}</span></div>
          ${ic.chevR()}
        </div>
        ${strip(blocked)}
      </a>`
    : "";
  if (blocked) app.animated.add(`card:${blocked.id}`);

  const pendingCard = pending
    .map(
      (r) => `<button type="button" class="alert-card ask press" style="text-align:left;width:100%" id="req-${esc(r.id)}" data-req="${esc(r.id)}">
        <div class="alert-head">
          <span class="round-ic ask">${ic.ask()}</span>
          <div class="stack"><span class="t15b">결제 전에 물어봐요</span><span class="muted t13 ellipsis">${esc(r.seller)} · ${usdc(r.amount)} USDC · 처음 보는 판매자</span></div>
          ${ic.chevR()}
        </div>
      </button>`,
    )
    .join("");

  // 맡긴 일 진행 중 (Working): 청구서 받음 → 지갑이 확인 중 → 결제. 가장 최근 일 하나는 펼쳐 두고, 나머지는 "진행 중인 일 n개 더"에 접어 둔다
  const actives = [...d.tasks].sort((a, b) => b.created_at - a.created_at).filter((t) => t.status === "open" || t.status === "working" || t.status === "paused");
  const taskStep = (t: Task) => (d.history.some((e) => e.task_id === t.id && e.status === "paid") ? 3 : t.order_refs.length > 0 ? 1 : 0);
  const taskCard = (t: Task) => {
    const cur = taskStep(t);
    const held = t.status === "paused";
    const ago = Math.max(0, Math.floor(Date.now() / 1000 - t.created_at));
    const steps = ["청구서 받음", "지갑이 확인 중", "결제"]
      .map((s, i) => `<li class="${held ? (i < cur ? "done" : "") : i < cur ? "done" : i === cur ? "now" : ""}" ${i === cur && !held ? 'aria-current="step"' : ""}><span class="b"></span><span>${s}</span></li>`)
      .join("");
    return `<section class="work-card" id="task-${esc(t.id)}" aria-label="맡긴 일">
      <div class="stack"><span class="t15b ellipsis">${esc(t.text)}</span><span class="dim t13">${held ? '<span style="color:var(--ask)">멈춤</span> · ' : ""}최대 ${usdc(t.max_amount)} USDC · ${ago < 60 ? "방금 맡김" : ago < 3600 ? `${Math.floor(ago / 60)}분 전 맡김` : `${Math.floor(ago / 3600)}시간 전 맡김`}</span></div>
      <ol class="work-steps">${steps}</ol>
      <div class="work-acts">
        <button type="button" class="pill" data-task-pause="${esc(t.id)}" data-on="${held ? "1" : ""}">${held ? "다시 시작" : "이 일 멈추기"}</button>
        <button type="button" class="pill" data-task-cancel="${esc(t.id)}">취소</button>
      </div>
    </section>`;
  };
  let workingCard = "";
  if (actives.length && !paused) {
    const [first, ...rest] = actives;
    workingCard = `${taskCard(first!)}${
      rest.length
        ? `<details class="more-tasks" data-k="more-tasks"><summary class="press"><span class="muted t14">진행 중인 일 ${rest.length}개 더</span><span class="dim">${ic.chevD()}</span></summary>${rest.map(taskCard).join("")}</details>`
        : ""
    }`;
  }
  // 상태 줄: 기본은 "쉬는 중", 일이 있으면 지금 하는 일. 누르면 그 카드로
  const working = actives.find((t) => t.status !== "paused");
  let state: { dot: string; word: string; sub: string; target?: string };
  if (paused) state = { dot: "bad", word: "긴급 정지됨", sub: "결제를 모두 막고 있어요" };
  else if (d.offline) state = { dot: "off", word: "연결 끊김", sub: "" };
  else if (me?.paused) state = { dot: "bad", word: "이 에이전트 멈춤", sub: "다른 에이전트는 계속 결제해요" };
  else if (pending[0]) state = { dot: "ask", word: "결제 승인 기다리는 중", sub: `${pending[0].seller} · ${usdc(pending[0].amount)} USDC`, target: `req-${pending[0].id}` };
  else if (working) {
    const stepWord = ["청구서 기다리는 중", "지갑이 확인하는 중", "결제 끝"][Math.min(taskStep(working), 2)];
    state = { dot: "ask working", word: "일하는 중", sub: `${working.text} · ${stepWord}${actives.length > 1 ? ` · 외 ${actives.length - 1}개` : ""}`, target: `task-${working.id}` };
  } else
    state = {
      dot: me && !attached(me) ? "off" : "",
      word: "쉬는 중",
      sub: me ? `${me.name} ${agentState(me)}${others ? ` · 다른 에이전트 ${others}` : ""}` : "연결된 에이전트 없음",
    };

  const row = (e: HistoryEntry) => `
    <a href="#/p/${esc(e.id)}" class="list-row">
      <span class="round-ic">${e.status === "paid" ? ic.check(16, "#A0A0AA") : ic.blocked(16, e.status === "rejected" ? "#FF5C5C" : "#A0A0AA")}</span>
      <div class="stack"><span class="t15" style="font-weight:500">${esc(entryTitle(e))}</span><span class="dim t13 ellipsis">${esc(shortReason(e))} · ${hhmm(e.at)}</span></div>
      <div class="right"><span class="t15" ${e.status === "paid" ? "" : 'style="color:var(--fg3)"'}>${e.status === "paid" && e.kind !== "withdraw" ? "−" : ""}${usdc(e.amount)}</span><span class="t12" style="color:${e.status === "rejected" ? "var(--bad-text)" : "var(--fg2)"}">${statusWord(e)}</span></div>
    </a>`;

  const html = `
  <div class="screen with-tabs with-input">
    <div class="topbar">
      <button type="button" class="chip-agent press" data-act="agents"><span class="av"><img src="/mark.svg" width="22" height="22" alt=""></span>${esc(agentName)}${ic.chevD()}</button>
      <span class="chip-net">${esc(chainShort(chainIds(p)[0]) || "—")}${app.api.mock ? " · 데모" : ""}</span>
    </div>
    ${banner}
    <${state.target ? `button type="button" data-goto="${esc(state.target)}"` : "div"} class="status-line ${banner ? "hidden" : ""} ${state.target ? "press" : ""}">
      <span class="dot ${state.dot}"></span>
      <span style="flex:none">${state.word}</span>
      <span class="dim ellipsis" style="min-width:0">${esc(state.sub)}</span>${state.target ? `<span class="dim" style="flex:none;margin-left:auto">${ic.chevR()}</span>` : ""}
    </${state.target ? "button" : "div"}>
    <div class="muted" style="margin-top:16px;font-size:14px">결제용 잔액${app.api.mock ? ' <span class="dim">· 데모 값, 진짜 USDC 아님</span>' : ""}</div>
    <div class="balance"><span class="num" data-bal ${balNum === undefined ? 'style="color:var(--fg3)"' : ""}>${balNum !== undefined ? (lastBalance ?? balNum).toFixed(2) : "-.--"}</span><span class="unit">USDC</span></div>
    ${balNum === undefined && d.balance?.balances[0]?.error ? `<div class="dim t12" style="margin-top:4px">잔액을 못 읽었어요: ${esc(d.balance.balances[0].error)}</div>` : ""}
    <div style="margin-top:20px;display:flex;justify-content:space-between;font-size:13px">
      <span class="muted">오늘 쓴 돈</span>
      <span><span data-spent>${(lastSpent ?? spent).toFixed(2)}</span> <span class="dim">/ ${usdc(p?.daily_max)} USDC</span></span>
    </div>
    <div class="meter"><div style="transform:scaleX(${ratio})"></div></div>
    <div class="dim t12" style="margin-top:8px">1회 최대 ${usdc(p?.per_tx_max)} USDC</div>
    <div class="row-2">
      ${gone ? "" : `<button type="button" class="btn-card press" data-act="deposit">${ic.down()}입금</button>`}
      <button type="button" class="btn-card press" data-act="withdraw">${ic.up(18, "currentColor")}출금</button>
      ${
        paused
          ? `<button type="button" class="btn-card press" style="color:var(--ok)" data-act="resume">${ic.play()}다시 켜기</button>`
          : `<button type="button" class="btn-card press" style="color:var(--bad)" data-act="stop">${ic.stop()}긴급 정지</button>`
      }
    </div>
    ${workingCard}
    ${pendingCard}
    ${blockedCard}
    <div class="section-head"><span class="h">최근 결제</span><a href="#/activity" class="muted t13">전체 보기</a></div>
    <div style="display:flex;flex-direction:column;margin-top:4px">${recent.length ? recent.map(row).join("") : `<div class="empty-state"><span class="t15" style="font-weight:500">아직 결제가 없어요</span><span class="dim t13" style="line-height:20px">아래 입력칸에 할 일을 적으면<br>에이전트가 결제할 때마다 여기 보여요</span></div>`}</div>
  </div>
  ${tabs("home")}`;

  return {
    html,
    bind: (root) => {
      showComposer({
        locked:
          gone || runnerOff || paused || needsRules
            ? gone
              ? "연결 끊은 에이전트라 일을 맡길 수 없어요"
              : paused
                ? "정지 중에는 맡길 수 없어요"
                : runnerOff
                  ? "에이전트가 꺼져 있어요"
                  : "기본 규칙을 정하면 일을 맡길 수 있어요"
            : undefined,
        agent: agentName,
        perTx: p?.per_tx_max ?? "0.5",
        recent: [...new Set([...d.tasks].sort((a, b) => b.created_at - a.created_at).map((t) => t.text))].slice(0, 3),
      });
      if (balNum !== undefined) countTo(root.querySelector("[data-bal]"), lastBalance ?? balNum, balNum);
      countTo(root.querySelector("[data-spent]"), lastSpent ?? spent, spent);
      lastBalance = balNum;
      lastSpent = spent;
      root.querySelector("[data-seen]")?.addEventListener("click", (e) => store.markSeen((e.currentTarget as HTMLElement).dataset.seen!));
      root.querySelectorAll<HTMLElement>("[data-req]").forEach((b) =>
        b.addEventListener("click", () => {
          const r = app.data.requests.find((x) => x.id === b.dataset.req);
          if (r) openApproval(r);
        }),
      );
      root.addEventListener("click", (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "deposit") deposit();
        if (act === "withdraw") withdrawSheet();
        if (act === "retry") {
          (e.target as HTMLElement).closest("button")!.textContent = "확인 중…";
          void refresh();
        }
        if (act === "stop") stopSheet();
        if (act === "resume") void resume();
        if (act === "agents") agentsSheet();
        const t = e.target as HTMLElement;
        // 상태 줄을 누르면: 승인 기다리는 결제는 그 구매 요청 시트, 하는 일은 내역에서 그 일을 펼쳐서
        const goto = t.closest<HTMLElement>("[data-goto]")?.dataset.goto;
        if (goto?.startsWith("req-")) {
          const r = app.data.requests.find((x) => x.id === goto.slice(4));
          if (r) openApproval(r);
        } else if (goto?.startsWith("task-")) {
          app.focusTask = goto.slice(5);
          go("activity");
        }
        const pauseBtn = t.closest<HTMLElement>("[data-task-pause]");
        if (pauseBtn) {
          const id = pauseBtn.dataset.taskPause!;
          const resume = !!pauseBtn.dataset.on;
          void busy(pauseBtn, resume ? "다시 시작하는 중" : "멈추는 중", () => app.api.pauseTask(id, !resume))
            .then(() => toast(resume ? "이 일을 다시 시작했어요" : "이 일을 멈췄어요 · 다른 일은 계속해요"))
            .catch((x) => toast(x instanceof ApiError ? x.message : "바꾸지 못했어요"))
            .finally(refreshSoon);
        }
        const cancelBtn = t.closest<HTMLElement>("[data-task-cancel]");
        if (cancelBtn) {
          const id = cancelBtn.dataset.taskCancel!;
          void busy(cancelBtn, "취소하는 중", () => app.api.cancelTask(id))
            .then(() => toast("이 일을 취소했어요 · 이 일로는 더 결제하지 않아요"))
            .catch((x) => toast(x instanceof ApiError ? x.message : "취소하지 못했어요"))
            .finally(refreshSoon);
        }
      });
    },
  };
}

/** 데모 입금: 진짜 주소·QR은 보여 주지 않는다 (가짜 주소로 진짜 돈을 보내지 않게). 누르면 가짜 USDC가 들어온다 */
function demoDepositSheet(api: MockOwnerApi): void {
  const empty = api.demoEmpty();
  openSheet(
    `<h1 class="title-md">입금</h1>
     <div class="banner ask" role="note" style="margin-top:14px"><span class="dot ask"></span>
       <span class="stack"><span class="t14">데모예요 · 진짜 USDC는 오가지 않아요</span><span class="dim t12">계정을 만든다고 USDC가 들어오지 않아요. 실제 지갑은 이 화면에 지갑 서버의 입금 주소가 나와요</span></span></div>
     <p class="muted t13" style="margin-top:14px;line-height:20px">${empty ? "아래를 누르면 가짜 26.10 USDC가 들어온 것처럼 이어가요" : "이미 데모 잔액이 있어요"}</p>
     <div class="bottom-actions" style="padding-top:16px">
       ${empty ? '<button class="btn btn-primary press" data-act="fake">가짜 26.10 USDC 받기</button>' : ""}
       <button class="btn btn-ghost press" data-act="close">닫기</button>
     </div>`,
    (sheet, close) =>
      sheet.addEventListener("click", async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "close") return void close();
        if (act === "fake") {
          api.demoDeposit();
          await close();
          toast("데모 · 가짜 26.10 USDC를 넣었어요");
          refreshSoon();
        }
      }),
    { label: "입금 (데모)" },
  );
}

/** 입금 주소: QR, 주소, 주소 복사·공유 (공유는 Web Share API로 주소와 QR 그림을 보낸다) */
export function deposit(): void {
  if (app.api instanceof MockOwnerApi) return demoDepositSheet(app.api);
  const me = currentAgent();
  const acct = me?.address ?? app.data.balance?.account ?? app.data.policy?.account;
  const chainId = me?.chain_id ?? chainIds(app.data.policy)[0] ?? 11155111;
  const net = chainName(chainId);
  const link = acct ? addressUrl(acct, chainId) : undefined;
  openSheet(
    `<h1 class="title-md">${esc(me?.name ?? "에이전트")} 입금 주소</h1>
     <p class="muted t13" style="margin-top:6px">${esc(net)} · Circle 테스트 USDC만 보내 주세요${me?.account_index !== undefined ? ` · 이 에이전트 전용 계정(${me.account_index}번)` : ""}</p>
     ${acct ? `<div style="align-self:center;margin-top:16px;width:200px;height:200px;border-radius:16px;background:#F7F7F9;padding:12px"><img data-qr alt="입금 주소 QR" width="176" height="176" style="display:block;width:176px;height:176px"></div>` : ""}
     <div class="inner" style="margin-top:16px">${acct ? addrHtml(acct) : '<span class="dim">signer가 꺼져 있어 주소를 몰라요</span>'}</div>
     ${
       acct
         ? `<div class="btn-pair" style="margin-top:16px">
             <button class="btn btn-card press" data-act="share">${ic.share()}<span style="margin-left:8px">공유</span></button>
             <button class="btn btn-primary press" data-act="copy">주소 복사</button>
           </div>
           ${link ? `<a class="muted t13" style="align-self:center;margin-top:14px;text-decoration:underline" href="${esc(link)}" target="_blank" rel="noopener noreferrer">탐색기에서 이 계정 보기</a>` : ""}
           <p class="dim t12" style="margin-top:12px;line-height:18px;text-align:center">테스트 USDC는 faucet.circle.com에서 Ethereum Sepolia로 받을 수 있어요</p>`
         : ""
     }`,
    (sheet, close) => {
      if (!acct) return;
      let qrUrl: string | undefined;
      void import("qrcode").then(async (QR) => {
        qrUrl = await QR.toDataURL(acct, { margin: 0, width: 352, errorCorrectionLevel: "M", color: { dark: "#0B0B0D", light: "#F7F7F9" } });
        const img = sheet.querySelector<HTMLImageElement>("[data-qr]");
        if (img) img.src = qrUrl;
      });
      sheet.querySelector('[data-act="copy"]')?.addEventListener("click", async () => {
        await navigator.clipboard?.writeText(acct).catch(() => {});
        toast("주소를 복사했어요");
        await close();
      });
      sheet.querySelector('[data-act="share"]')?.addEventListener("click", async () => {
        const text = `Countersign 입금 주소 (${net}, USDC만)\n${acct}`;
        const files: File[] = [];
        if (qrUrl) {
          const blob = await (await fetch(qrUrl)).blob();
          files.push(new File([blob], "countersign-deposit.png", { type: "image/png" }));
        }
        try {
          if (files.length && navigator.canShare?.({ files })) await navigator.share({ title: "입금 주소", text, files });
          else if (navigator.share) await navigator.share({ title: "입금 주소", text });
          else {
            await navigator.clipboard?.writeText(text);
            toast("공유를 못 해서 주소를 복사했어요");
          }
        } catch {
          /* 공유 창을 닫음 */
        }
      });
    },
    { label: "입금 주소" },
  );
}

/** 출금: 이 에이전트 계정의 USDC를 주인 계정(지갑 서버의 0번 계정)으로. 받는 곳은 서버가 고정한다.
 * 금액은 늘 앱이 보낸다 (빈 칸이면 버튼이 꺼짐, "전액"은 칸을 잔액으로 채움) */
export function withdrawSheet(prefill = ""): void {
  const me = currentAgent();
  const bal = app.data.balance?.balances.find((b) => b.balance !== undefined)?.balance;
  if (app.api.mock) {
    toast("데모라 출금은 하지 않아요 · 실제 지갑에서는 주인 계정으로 옮겨요");
    return;
  }
  if (!me) return void toast("고른 에이전트가 없어요");
  openSheet(
    `<h1 class="title-md">${esc(me.name)} 잔액 출금</h1>
     <p class="muted t13" style="margin-top:6px;line-height:20px">주인 계정으로만 보내요 · 받는 곳은 지갑 서버가 정해서 바꿀 수 없어요</p>
     <div class="inner" style="margin-top:16px;display:flex;justify-content:space-between"><span class="muted t14">출금할 수 있는 돈</span><span class="t15">${bal !== undefined ? usdc(bal) : "-.--"} USDC</span></div>
     <label class="t13 dim" for="wd-amt" style="margin-top:16px">금액</label>
     <div style="display:flex;gap:8px;margin-top:8px">
       <input id="wd-amt" class="field" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(prefill)}">
       <button type="button" class="pill" data-act="all" style="height:52px;flex:none" ${bal !== undefined && Number(bal) > 0 ? "" : "disabled"}>전액</button>
     </div>
     <p class="err-text" style="margin-top:6px;min-height:18px" role="alert"></p>
     <div class="bottom-actions" style="padding-top:8px">
       <button class="btn btn-primary press" data-act="go" disabled>주인 계정으로 출금</button>
       <button class="btn btn-ghost press" data-act="cancel">취소</button>
     </div>`,
    (sheet, close) => {
      const input = sheet.querySelector<HTMLInputElement>("#wd-amt")!;
      const err = sheet.querySelector<HTMLElement>(".err-text")!;
      const go = sheet.querySelector<HTMLButtonElement>('[data-act="go"]')!;
      const check = (): string | undefined => {
        const v = input.value.trim().replace(",", ".");
        err.textContent = "";
        if (!v) return undefined;
        if (!/^\d+(\.\d{1,6})?$/.test(v) || Number(v) <= 0) return void (err.textContent = "숫자로 넣어 주세요 (소수 6자리까지)");
        if (bal !== undefined && Number(v) > Number(bal)) return void (err.textContent = "잔액보다 많아요");
        return v;
      };
      const sync = () => {
        const v = check();
        go.disabled = !v;
        go.textContent = v ? `${usdc(v)} USDC 출금` : "주인 계정으로 출금";
      };
      input.addEventListener("input", sync);
      sync();
      sheet.addEventListener("click", async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "cancel") return void close();
        if (act === "all" && bal !== undefined) {
          input.value = bal;
          return sync();
        }
        if (act !== "go") return;
        const v = check();
        if (!v) return;
        await close();
        if (!(await unlock({ title: "출금해요", subtitle: `${usdc(v)} USDC · 주인 계정으로`, closable: true }))) return;
        withdrawProgress(me.id, me.chain_id ?? 11155111, v);
      });
    },
    { label: "출금" },
  );
}

/** 출금 진행: 서명 → Sepolia로 보내기 → 끝(탐색기) / 실패(다시 시도). 지갑 서버 호출은 한 번이라 단계는 시간으로 넘기고, 끝과 실패는 응답으로 정한다 */
function withdrawProgress(agentId: string, chainId: number, amount: string): void {
  const steps = ["서명", "Sepolia로 전송", "완료"];
  const stepHtml = (cur: number, failed = false) =>
    `<ol class="work-steps" style="margin-top:20px">${steps
      .map((s, i) => `<li class="${i < cur ? "done" : i === cur ? (failed ? "fail" : "now") : ""}" ${i === cur ? 'aria-current="step"' : ""}><span class="b"></span><span>${s}</span></li>`)
      .join("")}</ol>`;
  let timer: number | undefined;
  openSheet(
    `<h1 class="title-md" data-title>${usdc(amount)} USDC 출금하는 중</h1>
     <p class="muted t13" style="margin-top:6px" data-sub>창을 닫아도 출금은 계속돼요</p>
     <div data-steps>${stepHtml(0)}</div>
     <div class="bottom-actions" style="padding-top:20px" data-actions>
       <button class="btn btn-ghost press" data-act="close">닫기</button>
     </div>`,
    (sheet, close) => {
      const $ = (k: string) => sheet.querySelector<HTMLElement>(`[data-${k}]`)!;
      let cur = 0;
      timer = window.setInterval(() => {
        if (cur < 1) $("steps").innerHTML = stepHtml(++cur);
      }, 1200);
      sheet.addEventListener("click", (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "close") void close();
        if (act === "retry") void close().then(() => withdrawSheet(amount));
      });
      app.api
        .withdraw(agentId, amount)
        .then((w) => {
          clearInterval(timer);
          const url = w.explorer_url ?? txUrl({ tx_hash: w.tx_hash, chain_id: chainId });
          $("title").textContent = `${usdc(w.amount)} USDC를 보냈어요`;
          $("sub").textContent = `받는 곳 ${w.to.slice(0, 6)}…${w.to.slice(-4)} · 블록에 들어가면 잔액이 바뀌어요`;
          $("steps").innerHTML = stepHtml(3);
          $("actions").innerHTML = `${url ? `<a class="btn btn-primary press" href="${esc(url)}" target="_blank" rel="noopener noreferrer">탐색기에서 거래 보기</a>` : ""}<button class="btn btn-ghost press" data-act="close">닫기</button>`;
          refreshSoon();
        })
        .catch((x) => {
          clearInterval(timer);
          $("title").textContent = "출금하지 못했어요";
          $("sub").textContent = x instanceof ApiError ? x.message : "지갑 서버에서 답이 없어요";
          $("sub").style.color = "var(--bad-text)";
          $("steps").innerHTML = stepHtml(cur, true);
          $("actions").innerHTML = `<button class="btn btn-primary press" data-act="retry">다시 시도</button><button class="btn btn-ghost press" data-act="close">닫기</button>`;
          refreshSoon();
        });
    },
    { label: "출금 진행", dismissable: false },
  );
}

function stopSheet(): void {
  openSheet(
    `<h1 class="title-md">결제를 모두 멈출까요?</h1>
     <p class="muted" style="margin-top:8px;line-height:22px;font-size:14px">지금부터 에이전트의 모든 결제를 서명하지 않고 거절해요. 다시 켤 때는 비밀번호를 물어봐요</p>
     <div class="bottom-actions" style="padding-top:20px">
       <button class="btn press" style="background:var(--bad);color:#0E0E10" data-act="go">긴급 정지</button>
       <button class="btn btn-ghost" data-act="cancel">취소</button>
     </div>`,
    (sheet, close) =>
      sheet.addEventListener("click", async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "cancel") await close();
        if (act === "go") {
          const btn = sheet.querySelector<HTMLElement>('[data-act="go"]');
          try {
            await busy(btn, "멈추는 중…", () => app.api.pause("주인이 폰에서 정지"));
            toast("결제를 모두 멈췄어요");
          } catch (err) {
            toast(err instanceof ApiError ? err.message : "멈추지 못했어요");
          }
          await close();
          refreshSoon();
        }
      }),
    { label: "긴급 정지" },
  );
}

async function resume(): Promise<void> {
  if (!(await unlock({ title: "결제를 다시 켜요", subtitle: "정책 안에서 에이전트가 다시 결제할 수 있어요", closable: true }))) return;
  try {
    await busy(undefined, "다시 켜는 중…", () => app.api.resume());
    toast("다시 지켜보는 중이에요");
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "다시 켜지 못했어요");
  }
  refreshSoon();
}

/** 에이전트 한 줄 설명: 상태 먼저, 마지막 활동은 뒤로 */
export function agentLine(a: Agent): string {
  if (!a.connected) return "연결 끊김";
  if (!attached(a)) return "연결 기다리는 중 · 에이전트 앱에 주소를 넣으면 붙어요";
  if (a.paused) return "멈춤 · 이 에이전트만 멈춰 있어요";
  const last = a.last_seen_at ?? a.last_activity_at ?? a.attached_at!;
  return `연결됨 · 마지막 활동 ${new Date(last * 1000).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
}

function agentRow(a: Agent): string {
  const cur = a.id === app.api.agentId;
  return `<div class="list-row"><button type="button" class="press" data-pick="${esc(a.id)}" aria-pressed="${cur}" style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;text-align:left">
    <span class="round-ic" style="${attached(a) && !a.paused ? "" : "opacity:0.4"}"><img src="/mark.svg" width="24" height="24" alt=""></span>
    <span class="stack" style="flex:1;min-width:0"><span class="t15b">${esc(a.name)}${cur ? ' <span class="dim t12">· 보는 중</span>' : ""}</span><span class="dim t13 ellipsis">${agentLine(a)}</span></span>
    ${cur ? ic.check(16, "#00C896") : ""}</button>
    <button type="button" class="icon-btn" data-edit="${esc(a.id)}" aria-label="${esc(a.name)} 편집">${ic.more()}</button></div>`;
}

export function agentsSheet(): void {
  const list = app.data.agents.filter((a) => a.connected);
  const gone = goneAgents();
  const showGone = gone.some((a) => a.id === app.api.agentId);
  openSheet(
    `<h1 class="title-md">에이전트</h1><p class="dim t13" style="margin-top:4px">누르면 그 에이전트의 잔액·한도·내역으로 바뀌어요</p>
     <div style="margin-top:12px;display:flex;flex-direction:column">${
       list.length ? list.map(agentRow).join("") : `<p class="empty">연결된 에이전트가 없어요</p>`
     }
       <button type="button" class="list-row press" data-act="connect" style="width:100%;min-height:56px;gap:12px"><span class="round-ic">${ic.plus()}</span><span class="t15">에이전트 연결하기</span></button>
       ${
         gone.length
           ? `<details class="gone-agents" ${showGone ? "open" : ""} style="margin-top:8px">
               <summary class="list-row press" style="min-height:48px;justify-content:space-between;cursor:pointer"><span class="muted t14">연결 끊은 에이전트 (${gone.length})</span><span class="dim">${ic.chevD()}</span></summary>
               <p class="dim t12" style="line-height:18px;margin:2px 0 6px">잔액·출금·내역만 볼 수 있어요 · 결제와 일 맡기기는 안 돼요</p>
               ${gone.map(agentRow).join("")}
             </details>`
           : ""
       }
     </div>`,
    (sheet, close) =>
      sheet.addEventListener("click", async (e) => {
        const t = e.target as HTMLElement;
        const pick = t.closest<HTMLElement>("[data-pick]")?.dataset.pick;
        if (pick) {
          await close();
          selectAgent(pick);
          return;
        }
        const edit = t.closest<HTMLElement>("[data-edit]")?.dataset.edit;
        const connect = t.closest('[data-act="connect"]');
        if (!edit && !connect) return;
        await close();
        go(edit ? `agent/${edit}` : "connect");
      }),
    { label: "에이전트" },
  );
}
