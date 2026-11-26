// 홈: 상태, 잔액, 오늘 한도, 입금·긴급 정지, 구매 요청, 방금 막은 결제, 최근 결제, 맡길 일 입력칸

import { addressUrl, ApiError, chainIds, txUrl, type Agent, type HistoryEntry } from "../api.js";
import { app, currentAgent, go, openSheet, refresh, refreshSoon, selectAgent, strip, type Screen } from "../app.js";
import { store } from "../auth.js";
import { addrHtml, countTo, esc, hhmm, ic, toast, usdc } from "../ui.js";
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
    <div class="status-line ${banner ? "hidden" : ""}">
      <span class="dot ${paused || me?.paused ? "bad" : d.offline || (me && !attached(me)) ? "off" : ""}"></span>
      <span>${paused ? "긴급 정지됨" : d.offline ? "연결 끊김" : me?.paused ? "이 에이전트 멈춤" : "지켜보는 중"}</span>
      <span class="dim">${
        paused
          ? "결제를 모두 막고 있어요"
          : me
            ? `${esc(me.name)} ${agentState(me)}${others ? ` · 다른 에이전트 ${others}` : ""}`
            : "연결된 에이전트 없음"
      }</span>
    </div>
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
      <button type="button" class="btn-card press" data-act="deposit">${ic.down()}입금</button>
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
        locked: runnerOff || paused || needsRules ? (paused ? "정지 중에는 맡길 수 없어요" : runnerOff ? "에이전트가 꺼져 있어요" : "기본 규칙을 정하면 일을 맡길 수 있어요") : undefined,
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

/** 출금: 이 에이전트 계정의 USDC를 주인 계정(지갑 서버의 0번 계정)으로. 받는 곳은 서버가 고정한다 */
function withdrawSheet(): void {
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
     <label class="t13 dim" for="wd-amt" style="margin-top:16px">금액 (비우면 전액)</label>
     <div style="display:flex;gap:8px;margin-top:8px">
       <input id="wd-amt" class="field" inputmode="decimal" autocomplete="off" placeholder="전액">
       <button type="button" class="pill" data-act="all" style="height:52px;flex:none">전액</button>
     </div>
     <p class="err-text" style="margin-top:6px;min-height:18px" role="alert"></p>
     <div class="bottom-actions" style="padding-top:8px">
       <button class="btn btn-primary press" data-act="go">주인 계정으로 출금</button>
       <button class="btn btn-ghost press" data-act="cancel">취소</button>
     </div>`,
    (sheet, close) => {
      const input = sheet.querySelector<HTMLInputElement>("#wd-amt")!;
      const err = sheet.querySelector<HTMLElement>(".err-text")!;
      sheet.addEventListener("click", async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "cancel") return void close();
        if (act === "all") return void (input.value = "");
        if (act !== "go") return;
        const v = input.value.trim().replace(",", ".");
        if (v && (!/^\d+(\.\d{1,6})?$/.test(v) || Number(v) <= 0)) return void (err.textContent = "금액을 숫자로 넣어 주세요 (소수 6자리까지)");
        if (v && bal !== undefined && Number(v) > Number(bal)) return void (err.textContent = "잔액보다 많아요");
        await close();
        if (!(await unlock({ title: "출금해요", subtitle: `${v ? `${v} USDC` : "전액"} · 주인 계정으로`, closable: true }))) return;
        try {
          const w = await app.api.withdraw(me.id, v || undefined);
          refreshSoon();
          withdrawDone(w.amount, w.to, w.explorer_url ?? txUrl({ tx_hash: w.tx_hash, chain_id: me.chain_id ?? 11155111 }));
        } catch (x) {
          toast(x instanceof ApiError ? x.message : "출금하지 못했어요");
        }
      });
    },
    { label: "출금" },
  );
}

function withdrawDone(amount: string, to: string, url?: string): void {
  openSheet(
    `<span class="round-ic" style="align-self:center;margin-top:8px">${ic.check(18, "#00C896")}</span>
     <h1 class="title-md" style="text-align:center;margin-top:12px">${usdc(amount)} USDC를 보냈어요</h1>
     <p class="muted t13" style="text-align:center;margin-top:6px">받는 곳 ${esc(to.slice(0, 6))}…${esc(to.slice(-4))} · 블록에 들어가면 잔액이 바뀌어요</p>
     <div class="bottom-actions" style="padding-top:20px">
       ${url ? `<a class="btn btn-primary press" href="${esc(url)}" target="_blank" rel="noopener noreferrer">탐색기에서 거래 보기</a>` : ""}
       <button class="btn btn-ghost press" data-act="close">닫기</button>
     </div>`,
    (sheet, close) => sheet.querySelector('[data-act="close"]')!.addEventListener("click", () => void close()),
    { label: "출금 완료" },
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
  if (!attached(a)) return "연결 기다리는 중 · 에이전트 앱에 주소를 넣으면 붙어요";
  if (a.paused) return "멈춤 · 이 에이전트만 멈춰 있어요";
  const last = a.last_seen_at ?? a.last_activity_at ?? a.attached_at!;
  return `연결됨 · 마지막 활동 ${new Date(last * 1000).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
}

export function agentsSheet(): void {
  const list = app.data.agents;
  openSheet(
    `<h1 class="title-md">에이전트</h1><p class="dim t13" style="margin-top:4px">누르면 그 에이전트의 잔액·한도·내역으로 바뀌어요</p>
     <div style="margin-top:12px;display:flex;flex-direction:column">${
       list.length
         ? list
             .map(
               (a) => `<div class="list-row"><button type="button" class="press" data-pick="${esc(a.id)}" aria-pressed="${a.id === app.api.agentId}" style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;text-align:left">
                 <span class="round-ic" style="${attached(a) && !a.paused ? "" : "opacity:0.4"}"><img src="/mark.svg" width="24" height="24" alt=""></span>
                 <span class="stack" style="flex:1;min-width:0"><span class="t15b">${esc(a.name)}${a.id === app.api.agentId ? ' <span class="dim t12">· 보는 중</span>' : ""}</span><span class="dim t13 ellipsis">${agentLine(a)}</span></span>
                 ${a.id === app.api.agentId ? ic.check(16, "#00C896") : ""}</button>
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
