// 결제 상세. 거절이면 "무슨 일이 있었나" 한 문장 → 대조 띠 → 근거(두 주소) → 에이전트가 다시 시도한 결과 → 기록은 접어 둔다.

import { CODE_TEXT, txUrl, type HistoryEntry } from "../api.js";
import { app, FIELD_LABEL, stripCells, strip, type Screen } from "../app.js";
import { store } from "../auth.js";
import { addrHtml, dayLabel, esc, hhmm, hhmmss, ic, usdc } from "../ui.js";
import { openApproval } from "./approval.js";
import { chainName } from "./common.js";

const ORDINAL = ["첫", "두 번째", "세 번째", "네 번째", "다섯 번째", "여섯 번째"];
const STAGE: Record<string, string> = {
  signed: "서명",
  finalized: "HSP 결제 번호 받음",
  submitted: "HSP에 제출",
  pending: "HSP 처리 중",
  "payment-safe": "결제 안전 확인",
  "payment-finalized": "결제 끝",
  failed: "HSP 실패",
};

export function detail(id: string): Screen {
  const e = app.data.history.find((x) => x.id === id);
  if (!e) {
    return {
      html: `<div class="screen"><div class="topbar"><a class="icon-btn" href="#/activity" aria-label="뒤로">${ic.back()}</a><span></span></div>
        <p class="empty" style="margin-top:40px">${app.data.loadedAt ? "이 결제를 찾지 못했어요" : "불러오는 중…"}</p></div>`,
    };
  }
  store.markSeen(e.id);
  const firstView = !app.animated.has(`detail:${e.id}`);
  app.animated.add(`detail:${e.id}`);
  const back = history.length > 1 ? `<button class="icon-btn" data-act="back" aria-label="뒤로">${ic.back()}</button>` : `<a class="icon-btn" href="#/home" aria-label="뒤로">${ic.back()}</a>`;
  const when = `${dayLabel(e.at)} ${hhmm(e.at)}`;
  const head = `<div class="topbar">${back}<span class="t13 dim">${esc(when)}</span></div>`;

  const body = isWithdraw(e)
    ? withdrawBody(e)
    : e.status === "paid"
      ? paidBody(e, firstView)
      : e.status === "confirming"
        ? confirmingBody(e)
        : e.status === "pending"
          ? pendingBody(e)
          : rejectedBody(e, firstView);
  return {
    html: `<div class="screen">${head}${body}${records(e)}</div>`,
    bind: (root) => {
      root.querySelector('[data-act="back"]')?.addEventListener("click", () => history.back());
      root.querySelector('[data-act="open-req"]')?.addEventListener("click", () => {
        const r = app.data.requests.find((x) => x.id === e.request_id);
        if (r) openApproval(r);
      });
    },
  };
}

function rejectedBody(e: HistoryEntry, animate: boolean): string {
  const t = CODE_TEXT[e.code ?? ""];
  const cells = stripCells(e);
  const stopAt = cells.findIndex((c) => c.cls === "mismatch");
  const payee = e.checks?.find((c) => c.field === "payee");
  const bad = e.checks?.find((c) => c.result === "mismatch");
  let evidence = "";
  if (e.code === "PAYEE_MISMATCH" && payee?.expected && payee.actual) {
    evidence = `
      <div style="margin-top:20px;display:flex;flex-direction:column;gap:16px" class="${animate ? "animate-mark" : ""}">
        <div class="kv"><span class="k">등록된 주소</span>${addrHtml(payee.expected).replace('class="addr"', 'class="addr" style="color:var(--fg)"')}</div>
        <div class="kv"><span class="k">청구서의 주소</span>${addrHtml(payee.actual, { diffWith: payee.expected })}</div>
        <p class="muted t13" style="line-height:20px">${samePrefixSuffix(payee.expected, payee.actual) ? "앞뒤가 같아서 눈으로는 놓치기 쉬워요" : "등록된 판매자 이름인데 받는 주소가 달라요"}</p>
      </div>`;
  } else if (bad && (bad.expected || bad.actual)) {
    evidence = `
      <div style="margin-top:20px;display:flex;flex-direction:column;gap:12px">
        ${bad.expected ? `<div class="kv"><span class="k">기준</span><span class="mono t13">${esc(bad.expected)}</span></div>` : ""}
        ${bad.actual ? `<div class="kv"><span class="k">청구서</span><span class="mono t13" style="color:var(--bad-text)">${esc(bad.actual)}</span></div>` : ""}
      </div>`;
  } else if (e.reason) {
    evidence = `<p class="muted t13" style="margin-top:16px;line-height:20px">${esc(e.reason)}</p>`;
  }
  const owner = e.code === "OWNER_REJECTED";
  return `
    <span class="t13" style="margin-top:12px;color:var(--bad)">${e.status === "failed" ? "실패" : "거절됨"} · 돈은 나가지 않았어요</span>
    <h1 class="title" style="margin-top:8px">${esc(t?.title ?? "서명하지 않았어요")}</h1>
    <p class="muted" style="margin-top:8px;line-height:22px">${esc(e.seller ?? "알 수 없는 판매자")}${e.amount ? ` · ${usdc(e.amount)} USDC` : ""}</p>
    <section class="card" style="margin-top:24px;padding:20px 16px 8px;display:flex;flex-direction:column">
      ${strip(e, { size: "lg", animate })}
      ${evidence}
      <p class="muted divider" style="margin-top:12px;padding:14px 0 8px;font-size:14px">${
        owner ? "내가 거절해서 서명하지 않았어요" : stopAt >= 0 ? `${ORDINAL[stopAt]} 칸에서 멈추고 서명하지 않았어요` : "검증을 마치지 못해 서명하지 않았어요"
      }</p>
    </section>
    ${followUp(e)}`;
}

function samePrefixSuffix(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.slice(0, 6) === y.slice(0, 6) && x.slice(-4) === y.slice(-4);
}

/** 같은 일에서 이 거절 뒤에 일어난 일: 다시 결제했으면 그 결제로 이어진다 */
function followUp(e: HistoryEntry): string {
  if (!e.task_id) return "";
  const later = app.data.history.filter((x) => x.task_id === e.task_id && x.at >= e.at && x.id !== e.id).sort((a, b) => a.at - b.at);
  const paid = later.find((x) => x.status === "paid");
  const task = app.data.tasks.find((t) => t.id === e.task_id);
  let row: string;
  if (paid) {
    row = `<a href="#/p/${esc(paid.id)}" class="list-row press appear" style="min-height:64px;animation-delay:1200ms">
      <span class="round-ic" style="width:32px;height:32px">${ic.check(16, "#00C896")}</span>
      <span class="stack"><span class="t15">에이전트가 새 청구서로 다시 결제했어요</span><span class="dim t13">${Math.max(1, paid.at - e.at)}초 뒤 · ${usdc(paid.amount)} USDC 결제됨</span></span>
      ${ic.chevR()}</a>`;
  } else if (task && (task.status === "open" || task.status === "working")) {
    row = `<div class="list-row" style="min-height:64px"><span class="round-ic" style="width:32px;height:32px">${ic.retry()}</span>
      <span class="stack"><span class="t15">에이전트가 새 청구서를 기다리는 중</span><span class="dim t13">맡긴 일: ${esc(task.text)}</span></span></div>`;
  } else return "";
  return `<section class="card" style="margin-top:12px;padding:4px 16px">${row}</section>`;
}

export function isWithdraw(e: HistoryEntry): boolean {
  return e.kind === "withdraw";
}

/** 거래 줄: 실제 체인 거래(explorer_url)는 탐색기로, HSP 연결 전 테스트 결제는 번호만 */
function txRow(e: HistoryEntry, label: string): string {
  // 지갑 서버는 실제 체인 거래에만 explorer_url을 붙인다 (출금은 tx_hash만 와도 실제 거래)
  const url = e.explorer_url ?? (isWithdraw(e) && !app.api.mock ? txUrl(e) : undefined);
  if (url)
    return `<section class="card" style="margin-top:12px;padding:4px 16px">
      <a class="list-row" href="${esc(url)}" target="_blank" rel="noopener noreferrer">
        <span class="stack"><span class="t15">${label} · 탐색기에서 보기</span><span class="dim t12 mono ellipsis">${esc(e.tx_hash ?? url)}</span></span>${ic.chevR()}
      </a>
    </section>`;
  if (!e.tx_hash) return "";
  return `<section class="card" style="margin-top:12px;padding:12px 16px">
      <span class="stack"><span class="t15">${label}</span><span class="dim t12 mono ellipsis">${esc(e.tx_hash)}</span>
      <span class="dim t12" style="margin-top:4px">${app.api.mock ? "데모라 체인에 없는 번호예요" : "HSP 연결 전 테스트 결제라 탐색기에는 아직 없어요"}</span></span>
    </section>`;
}

function withdrawBody(e: HistoryEntry): string {
  return `
    <span class="t13" style="margin-top:12px;color:var(--ok)">출금</span>
    <h1 class="title" style="margin-top:8px">주인 계정으로 ${usdc(e.amount)} USDC를 옮겼어요</h1>
    <p class="muted" style="margin-top:8px;line-height:22px">${e.chain_id ? esc(chainName(e.chain_id)) : ""}${e.to ? ` · 받는 곳 ${esc(e.to.slice(0, 6))}…${esc(e.to.slice(-4))}` : ""}</p>
    ${txRow(e, "출금 거래")}`;
}

/** 서명·제출은 됐는데 HSP 확정 전이거나 확인이 끊긴 결제. 돈이 나갔을 수 있다 */
function confirmingBody(e: HistoryEntry): string {
  const cut = e.code === "PAYMENT_UNCONFIRMED";
  return `
    <span class="t13" style="margin-top:12px;color:var(--ask)">확인 중 · 돈이 나갔을 수 있어요</span>
    <h1 class="title" style="margin-top:8px">${esc(e.seller ?? "판매자")}에 ${usdc(e.amount)} USDC 결제를 ${cut ? "확인하다 연결이 끊겼어요" : "확정하는 중이에요"}</h1>
    <p class="muted" style="margin-top:8px;line-height:22px">${
      cut
        ? "지갑은 서명하고 HSP에 보냈지만 확정 소식을 아직 못 받았어요. 지갑 서버가 같은 결제를 다시 확인하면 결제됨으로 바뀌어요"
        : "지갑이 여섯 칸을 맞춰 보고 서명해서 HSP에 보냈어요. 확정되면 결제됨으로 바뀌어요"
    }</p>
    <section class="card" style="margin-top:24px;padding:20px 16px 16px">
      ${strip({ status: "paid", checks: e.checks }, { size: "lg" })}
      <p class="muted" style="margin-top:16px;font-size:14px">여섯 칸을 모두 맞춰 보고 서명했어요</p>
    </section>
    ${e.tx_hash ? txRow(e, "결제 거래") : ""}`;
}

function paidBody(e: HistoryEntry, animate: boolean): string {
  // HSP 연결 전이라 결제는 지갑 서버의 테스트 결제다. 실제 체인 거래가 있을 때만 탐색기 링크
  const real = !!e.explorer_url;
  return `
    <span class="t13" style="margin-top:12px;color:var(--ok)">결제됨</span>
    <h1 class="title" style="margin-top:8px">${esc(e.seller ?? "판매자")}에 ${usdc(e.amount)} USDC를 냈어요</h1>
    <p class="muted" style="margin-top:8px;line-height:22px">${esc(e.purpose ?? "")}${e.chain_id ? ` · ${esc(chainName(e.chain_id))}` : ""}</p>
    <section class="card" style="margin-top:24px;padding:20px 16px 16px">
      ${strip(e, { size: "lg", animate })}
      <p class="muted" style="margin-top:16px;font-size:14px">여섯 칸을 모두 맞춰 보고 서명했어요</p>
    </section>
    ${real || e.tx_hash ? txRow(e, "결제 거래") : ""}`;
}

function pendingBody(e: HistoryEntry): string {
  const live = app.data.requests.some((r) => r.id === e.request_id);
  return `
    <span class="t13" style="margin-top:12px;color:var(--ask)">결제 전에 물어보는 중</span>
    <h1 class="title" style="margin-top:8px">${esc(CODE_TEXT.NEEDS_OWNER_APPROVAL!.title)}</h1>
    <p class="muted" style="margin-top:8px">${esc(e.seller ?? "")} · ${usdc(e.amount)} USDC</p>
    <section class="card" style="margin-top:24px;padding:20px 16px 16px">
      ${strip(e, { size: "lg" })}
      ${e.pay_to ? `<div class="kv" style="margin-top:16px"><span class="k">받는 주소</span>${addrHtml(e.pay_to)}</div>` : ""}
    </section>
    ${live ? `<div class="bottom-actions"><button class="btn btn-primary press" data-act="open-req">결제할지 정하기</button></div>` : `<p class="dim t13" style="margin-top:16px">답할 시간이 지나 결제하지 않았어요</p>`}`;
}

/** 개발자 정보: 거부 코드, 6칸 값, HSP 단계, 주문 번호·해시. 기본으로 접힘 */
function records(e: HistoryEntry): string {
  const checks = (e.checks ?? [])
    .map(
      (c) => `<div class="ck"><span class="${c.result === "mismatch" ? "" : "muted"}" style="${c.result === "mismatch" ? "color:var(--bad-text)" : ""}">${esc(FIELD_LABEL[c.field] ?? c.field)}</span>
        <span class="v">${esc({ match: "맞음", mismatch: "다름", needs_approval: "주인 확인", unchecked: "검사 안 함" }[c.result])}${c.expected ? `<br>기준 ${esc(c.expected)}` : ""}${c.actual && c.actual !== c.expected ? `<br>실제 ${esc(c.actual)}` : ""}</span></div>`,
    )
    .join("");
  const events = (e.events ?? []).map((v) => `<span><span class="dim">${hhmmss(v.at)}</span>  ${esc(STAGE[v.stage] ?? v.stage)}</span>`).join("");
  return `
  <section class="card" style="margin-top:12px;padding:0 16px">
    <details data-k="rec:${esc(e.id)}">
      <summary style="display:flex;align-items:center;height:48px;font-size:14px;color:var(--fg2)"><span style="flex:1">기록 자세히</span><span class="chev">${ic.chevD()}</span></summary>
      <div style="display:flex;flex-direction:column;gap:14px;padding-bottom:16px">
        ${
          e.code || e.next_action
            ? `<div class="code-box">${e.code ? `<span>code <span style="color:${e.status === "paid" ? "var(--fg)" : "var(--bad-text)"}">${esc(e.code)}</span></span>` : ""}${e.step ? `<span>step <span style="color:var(--fg)">${esc(e.step)}</span></span>` : ""}${e.next_action ? `<span>next_action <span style="color:var(--fg)">${esc(e.next_action)}</span></span>` : ""}</div>`
            : ""
        }
        ${checks ? `<div class="check-table">${checks}</div>` : ""}
        ${events ? `<div style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--fg2)">${events}</div>` : ""}
        <div class="mono t12 dim" style="display:flex;flex-direction:column;gap:4px;word-break:break-all">
          <span>주문 ${esc(e.order_ref)}</span>
          ${e.payment_id ? `<span>HSP ${esc(e.payment_id)}</span>` : ""}
          ${e.order_hash ? `<span>order_hash ${esc(e.order_hash)}</span>` : ""}
          ${e.agent ? `<span>에이전트 ${esc(e.agent)}</span>` : ""}
        </div>
      </div>
    </details>
  </section>`;
}
