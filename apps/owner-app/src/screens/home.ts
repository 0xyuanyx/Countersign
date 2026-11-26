// 홈: 상태, 잔액, 오늘 한도, 입금·긴급 정지, 구매 요청, 방금 막은 결제, 최근 결제, 맡길 일 입력칸

import { ApiError, chainIds, type Agent, type HistoryEntry } from "../api.js";
import { app, go, openSheet, refresh, refreshSoon, strip, type Screen } from "../app.js";
import { store } from "../auth.js";
import { addrHtml, countTo, esc, hhmm, ic, toast, usdc } from "../ui.js";
import { openApproval } from "./approval.js";
import { chainName, shortReason, statusWord, tabs } from "./common.js";
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
  const agentName = connected[0]?.name ?? p?.agent ?? "에이전트";
  const bal = d.balance?.balances.find((b) => b.balance !== undefined);
  const balNum = bal?.balance !== undefined ? Number(bal.balance) : undefined;
  const spent = Number(p?.spent_24h ?? 0);
  const daily = Number(p?.daily_max ?? 0);
  const ratio = daily > 0 ? Math.min(1, spent / daily) : 0;
  const blocked = justBlocked();
  const pending = d.requests.filter((r) => r.status === "pending");
  const recent = d.history.filter((e) => e.id !== blocked?.id && e.status !== "pending").slice(0, 3);
  const runnerOff = connected.length === 0 && !app.api.mock;
  const needsRules = !setupDone();
  const lowBalance = balNum !== undefined && p !== undefined && balNum < Number(p.per_tx_max);

  // 홈 상태 줄: 문제가 있을 때만 "지켜보는 중" 자리에 한 줄. 여러 개면 가장 급한 것 하나 (끊김 > 잔액 부족 > 에이전트 꺼짐)
  let banner = "";
  if (d.offline) {
    const mins = d.okAt ? Math.floor((Date.now() - d.okAt) / 60_000) : undefined;
    banner = `<div class="banner bad" role="status"><span class="dot bad"></span>
      <span class="stack"><span class="t14">지갑 서버와 연결이 끊겼어요</span><span class="dim t12">${mins === undefined ? "" : mins < 1 ? "방금 전 마지막 확인 · " : `${mins}분 전 마지막 확인 · `}에이전트 결제도 멈춰 있어요</span></span>
      <button type="button" class="banner-act" data-act="retry">다시 시도</button></div>`;
  } else if (!paused && lowBalance) {
    banner = `<button type="button" class="banner ask" role="status" data-act="deposit"><span class="dot ask"></span>
      <span class="stack" style="text-align:left"><span class="t14">잔액이 ${balNum!.toFixed(2)} USDC 남았어요</span><span class="dim t12">1회 한도 ${usdc(p!.per_tx_max)}보다 적어서 결제가 막힐 수 있어요</span></span>
      <span class="banner-act">입금</span></button>`;
  } else if (!paused && runnerOff) {
    banner = `<div class="banner" role="status"><span class="dot off"></span>
      <span class="stack"><span class="t14">에이전트가 꺼져 있어요</span><span class="dim t12">맡길 일 입력칸이 잠겨요 · 에이전트를 켜면 풀려요</span></span></div>`;
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
      (r) => `<button type="button" class="alert-card ask press" style="text-align:left;width:100%" data-req="${esc(r.id)}">
        <div class="alert-head">
          <span class="round-ic ask">${ic.ask()}</span>
          <div class="stack"><span class="t15b">결제 전에 물어봐요</span><span class="muted t13 ellipsis">${esc(r.seller)} · ${usdc(r.amount)} USDC · 처음 보는 판매자</span></div>
          ${ic.chevR()}
        </div>
      </button>`,
    )
    .join("");

  // 맡긴 일 진행 중 (Working): 청구서 받음 → 지갑이 확인 중 → 결제
  const active = [...d.tasks].sort((a, b) => b.created_at - a.created_at).find((t) => t.status === "open" || t.status === "working");
  let workingCard = "";
  if (active && !paused) {
    const paidNow = d.history.some((e) => e.task_id === active.id && e.status === "paid");
    const got = active.order_refs.length > 0;
    const cur = paidNow ? 3 : got ? 1 : 0;
    const ago = Math.max(0, Math.floor(Date.now() / 1000 - active.created_at));
    const steps = ["청구서 받음", "지갑이 확인 중", "결제"]
      .map((s, i) => `<li class="${i < cur ? "done" : i === cur ? "now" : ""}" ${i === cur ? 'aria-current="step"' : ""}><span class="b"></span><span>${s}</span></li>`)
      .join("");
    workingCard = `<section class="work-card" aria-label="지금 맡긴 일">
      <div class="stack"><span class="t15b ellipsis">${esc(active.text)}</span><span class="dim t13">최대 ${usdc(active.max_amount)} USDC · ${ago < 60 ? "방금 맡김" : `${Math.floor(ago / 60)}분 전 맡김`}</span></div>
      <ol class="work-steps">${steps}</ol>
    </section>`;
  }

  const row = (e: HistoryEntry) => `
    <a href="#/p/${esc(e.id)}" class="list-row">
      <span class="round-ic">${e.status === "paid" ? ic.check(16, "#A0A0AA") : ic.blocked(16, e.status === "rejected" ? "#FF5C5C" : "#A0A0AA")}</span>
      <div class="stack"><span class="t15" style="font-weight:500">${esc(e.seller ?? "알 수 없는 판매자")}</span><span class="dim t13 ellipsis">${esc(shortReason(e))} · ${hhmm(e.at)}</span></div>
      <div class="right"><span class="t15" ${e.status === "paid" ? "" : 'style="color:var(--fg3)"'}>${e.status === "paid" ? "−" : ""}${usdc(e.amount)}</span><span class="t12" style="color:${e.status === "rejected" ? "var(--bad-text)" : "var(--fg2)"}">${statusWord(e)}</span></div>
    </a>`;

  const html = `
  <div class="screen with-tabs with-input">
    <div class="topbar">
      <button type="button" class="chip-agent press" data-act="agents"><span class="av"><img src="/mark.svg" width="22" height="22" alt=""></span>${esc(agentName)}${ic.chevD()}</button>
      <span class="chip-net">${esc(chainName(chainIds(p)[0]) || "—")}${app.api.mock ? " · 데모" : ""}</span>
    </div>
    ${banner}
    <div class="status-line ${banner ? "hidden" : ""}">
      <span class="dot ${paused ? "bad" : d.offline ? "off" : ""}"></span>
      <span>${paused ? "긴급 정지됨" : d.offline ? "연결 끊김" : "지켜보는 중"}</span>
      <span class="dim">${paused ? "결제를 모두 막고 있어요" : connected.length ? `${esc(connected.map((a) => a.name).join(", "))} 연결됨` : "연결된 에이전트 없음"}</span>
    </div>
    <div class="muted" style="margin-top:16px;font-size:14px">결제용 잔액</div>
    <div class="balance"><span class="num" data-bal ${balNum === undefined ? 'style="color:var(--fg3)"' : ""}>${balNum !== undefined ? (lastBalance ?? balNum).toFixed(2) : "-.--"}</span><span class="unit">USDC</span></div>
    ${balNum === undefined && d.balance?.balances[0]?.error ? `<div class="dim t12" style="margin-top:4px">잔액을 못 읽었어요: ${esc(d.balance.balances[0].error)}</div>` : ""}
    <div style="margin-top:20px;display:flex;justify-content:space-between;font-size:13px">
      <span class="muted">오늘 쓴 돈</span>
      <span><span data-spent>${(lastSpent ?? spent).toFixed(2)}</span> <span class="dim">/ ${usdc(p?.daily_max)} USDC</span></span>
    </div>
    <div class="meter"><div style="transform:scaleX(${ratio})"></div></div>
    <div class="dim t12" style="margin-top:8px">1회 최대 ${usdc(p?.per_tx_max)} USDC</div>
    <div class="row-2">
      <button type="button" class="btn-card press" data-act="deposit">${ic.down()}입금 주소</button>
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
        locked: runnerOff || paused || needsRules ? (paused ? "정지 중에는 맡길 수 없어요" : runnerOff ? "에이전트가 꺼져 있어요" : "기본 규칙을 정하면 일을 맡길 수 있어요") : undefined,
        agent: connected.map((a) => a.name).join(", ") || agentName,
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
        if (act === "retry") {
          (e.target as HTMLElement).closest("button")!.textContent = "확인 중…";
          void refresh();
        }
        if (act === "stop") stopSheet();
        if (act === "resume") void resume();
        if (act === "agents") agentsSheet();
      });
    },
  };
}

/** 입금 주소: QR, 주소, 주소 복사·공유 (공유는 Web Share API로 주소와 QR 그림을 보낸다) */
export function deposit(): void {
  // 데모: 빈 지갑이면 입금 주소를 연 뒤 몇 초 있다 USDC가 들어온 것처럼 보여 준다
  if (app.api instanceof MockOwnerApi && app.api.demoDeposit()) {
    setTimeout(() => {
      toast("데모 · 26.10 USDC가 들어왔어요");
      refreshSoon();
    }, 3100);
  }
  const acct = app.data.balance?.account ?? app.data.policy?.account;
  const net = chainName(chainIds(app.data.policy)[0]);
  openSheet(
    `<h1 class="title-md">입금 주소</h1>
     <p class="muted t13" style="margin-top:6px">${esc(net)} · USDC만 보내 주세요</p>
     ${acct ? `<div style="align-self:center;margin-top:16px;width:200px;height:200px;border-radius:16px;background:#F7F7F9;padding:12px"><img data-qr alt="입금 주소 QR" width="176" height="176" style="display:block;width:176px;height:176px"></div>` : ""}
     <div class="inner" style="margin-top:16px">${acct ? addrHtml(acct) : '<span class="dim">signer가 꺼져 있어 주소를 몰라요</span>'}</div>
     ${
       acct
         ? `<div class="btn-pair" style="margin-top:16px">
             <button class="btn btn-card press" data-act="share">${ic.share()}<span style="margin-left:8px">공유</span></button>
             <button class="btn btn-primary press" data-act="copy">주소 복사</button>
           </div>`
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
          try {
            await app.api.pause("주인이 폰에서 정지");
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
    await app.api.resume();
    toast("다시 지켜보는 중이에요");
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "다시 켜지 못했어요");
  }
  refreshSoon();
}

/** 에이전트 한 줄 설명: 상태 먼저, 마지막 활동은 뒤로 */
export function agentLine(a: Agent): string {
  if (!a.connected) return "연결 끊김";
  if (a.paused) return "멈춤 · 이 에이전트만 멈춰 있어요";
  return a.last_activity_at ? `연결됨 · 마지막 활동 ${new Date(a.last_activity_at * 1000).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}` : "연결됨";
}

function agentsSheet(): void {
  const list = app.data.agents;
  openSheet(
    `<h1 class="title-md">에이전트</h1>
     <div style="margin-top:12px;display:flex;flex-direction:column">${
       list.length
         ? list
             .map(
               (a) => `<div class="list-row"><span class="round-ic" style="${a.connected && !a.paused ? "" : "opacity:0.4"}"><img src="/mark.svg" width="24" height="24" alt=""></span>
                 <div class="stack" style="flex:1"><span class="t15b">${esc(a.name)}</span><span class="dim t13">${agentLine(a)}</span></div>
                 <button type="button" class="icon-btn" data-edit="${esc(a.id)}" aria-label="${esc(a.name)} 편집">${ic.more()}</button></div>`,
             )
             .join("")
         : `<p class="empty">연결된 에이전트가 없어요</p>`
     }
       <button type="button" class="list-row press" data-act="connect" style="width:100%;min-height:56px;gap:12px"><span class="round-ic">${ic.plus()}</span><span class="t15">에이전트 연결하기</span></button>
     </div>`,
    (sheet, close) =>
      sheet.addEventListener("click", async (e) => {
        const t = e.target as HTMLElement;
        const edit = t.closest<HTMLElement>("[data-edit]")?.dataset.edit;
        const connect = t.closest('[data-act="connect"]');
        if (!edit && !connect) return;
        await close();
        go(edit ? `agent/${edit}` : "connect");
      }),
    { label: "에이전트" },
  );
}
