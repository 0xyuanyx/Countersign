// 산 것(판매자 확인서). 결제 상세 맨 위 요약 + "상세보기" 시트.
// receipt는 판매 서버 응답에서 온 값이다 (에이전트가 쓴 글이 아님). 링크는 https만 연다.

import type { HistoryEntry, Receipt } from "../api.js";
import { openSheet } from "../app.js";
import { esc, usdc } from "../ui.js";

const KIND: Record<string, string> = { flight: "항공권", hotel: "숙박", data: "데이터" };

function safeUrl(u?: string): string | undefined {
  try {
    return u && new URL(u).protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

/** 결제 상세 맨 위: 무엇을 샀는지 */
export function receiptSummary(e: HistoryEntry): string {
  const r = e.receipt;
  if (!r?.title) return "";
  // 요약엔 앞의 두 줄만 (나머지는 상세보기)
  const lines = (r.lines ?? []).filter((l) => l.label !== "결제").slice(0, 2);
  return `<section class="receipt-sum" aria-label="산 것">
    <span class="t12 dim">${esc(KIND[r.kind ?? ""] ?? "산 것")} · ${esc(e.seller ?? "판매자")}가 보낸 확인서</span>
    <span class="t17b">${esc(r.title)}</span>
    ${lines.map((l) => `<span class="t13 muted">${esc(l.label)} ${esc(l.value)}</span>`).join("")}
    ${r.confirmation ? `<span class="t13">확인 번호 <span class="mono">${esc(r.confirmation)}</span></span>` : ""}
    <button type="button" class="pill press" data-act="receipt" style="align-self:flex-start;margin-top:6px">예약 상세보기</button>
  </section>`;
}

export function openReceipt(e: HistoryEntry): void {
  const r: Receipt | undefined = e.receipt;
  if (!r) return;
  const url = safeUrl(r.url);
  const lines = r.lines ?? [];
  const hasPay = lines.some((l) => l.label === "결제");
  openSheet(
    `<span class="t12 dim">${esc(KIND[r.kind ?? ""] ?? "산 것")} · ${esc(e.seller ?? "판매자")}가 보낸 확인서</span>
     <h1 class="title-md" style="margin-top:4px">${esc(r.title)}</h1>
     ${r.confirmation ? `<div class="receipt-code"><span class="t12 dim">예약 확인 번호</span><span class="mono">${esc(r.confirmation)}</span></div>` : ""}
     <div class="receipt-lines">
       ${lines.map((l) => `<div><span>${esc(l.label)}</span><span>${esc(l.value)}</span></div>`).join("")}
       ${hasPay ? "" : `<div><span>낸 돈</span><span>${usdc(e.amount)} USDC</span></div>`}
       ${e.status === "paid" ? `<div><span>지갑 대조</span><span style="color:var(--ok)">6칸 모두 맞음</span></div>` : ""}
     </div>
     ${url ? `<a class="btn btn-card press" style="margin-top:16px" href="${esc(url)}" target="_blank" rel="noopener noreferrer">판매자 확인서 원본 열기</a>` : ""}
     <div class="bottom-actions" style="padding-top:12px"><button class="btn btn-primary press" data-act="close">닫기</button></div>`,
    (sheet, close) => sheet.querySelector('[data-act="close"]')?.addEventListener("click", () => void close()),
    { label: "예약 상세" },
  );
}
