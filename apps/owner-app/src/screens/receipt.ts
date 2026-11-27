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

const AIRPORT: Record<string, string> = { 인천: "ICN", 김포: "GMP", 하네다: "HND", 나리타: "NRT", 간사이: "KIX", 김해: "PUS", 제주: "CJU" };

/** "CS101 · 12/07 10:25 인천 → 13:05 하네다" 같은 줄을 나눈다. 모양이 다르면 undefined */
function legOf(v: string): { flight: string; date: string; dep: string; from: string; arr: string; to: string } | undefined {
  const m = /^(\S+)\s*·\s*(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})\s+(\S+)\s*→\s*(\d{1,2}:\d{2})\s+(\S+)$/.exec(v.trim());
  return m ? { flight: m[1]!, date: m[2]!, dep: m[3]!, from: m[4]!, arr: m[5]!, to: m[6]! } : undefined;
}

function cell(label: string, value: string, mono = false): string {
  return `<div><span>${esc(label)}</span><b class="${mono ? "mono" : ""}">${esc(value)}</b></div>`;
}

/** 티켓 모양: 항공은 탑승권처럼, 숙박은 체크인·체크아웃을 크게. 모양을 모르면 제목 + 칸 */
function ticket(r: Receipt, seller: string): string {
  const lines = (r.lines ?? []).filter((l) => l.label !== "결제");
  const used = new Set<string>();
  let top = "";
  if (r.kind === "flight") {
    const goL = lines.find((l) => l.label === "가는 편");
    const leg = goL && legOf(goL.value);
    if (leg) {
      used.add("가는 편");
      top = `<div class="tk-row dim2"><span>${esc(seller)} · ${esc(leg.flight)}</span><span>${esc(leg.date)}</span></div>
        <div class="tk-route">
          <div><b>${esc(AIRPORT[leg.from] ?? leg.from)}</b><span>${esc(leg.from)} ${esc(leg.dep)}</span></div>
          <svg width="80" height="20" viewBox="0 0 80 20" fill="none" stroke="#8A8990" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 10h76"/><path d="M70 5l8 5-8 5"/></svg>
          <div style="text-align:right"><b>${esc(AIRPORT[leg.to] ?? leg.to)}</b><span>${esc(leg.to)} ${esc(leg.arr)}</span></div>
        </div>`;
    }
  } else if (r.kind === "hotel") {
    const ci = lines.find((l) => l.label === "체크인");
    const co = lines.find((l) => l.label === "체크아웃");
    const near = lines.find((l) => l.label.includes("까지"));
    [ci, co, near].forEach((l) => l && used.add(l.label));
    top = `<div class="tk-name">${esc(r.title)}</div>${near ? `<div class="dim2 t13">${esc(near.label)} ${esc(near.value)}</div>` : ""}
      ${ci || co ? `<div class="tk-row" style="margin-top:14px;align-items:flex-end"><div class="tk-kv"><span>체크인</span><b>${esc(ci?.value ?? "–")}</b></div><div class="tk-kv" style="text-align:right"><span>체크아웃</span><b>${esc(co?.value ?? "–")}</b></div></div>` : ""}`;
  }
  if (!top) top = `<div class="tk-name">${esc(r.title)}</div>`;
  const rest = lines.filter((l) => !used.has(l.label));
  const cells = [...rest.map((l) => cell(l.label, l.value)), ...(r.confirmation ? [cell(r.kind === "flight" ? "예약 번호" : "확인 번호", r.confirmation, true)] : [])];
  return `<div class="ticket"><div class="tk-top">${top}</div>${cells.length ? `<div class="tk-cut"></div><div class="tk-bot">${cells.join("")}</div>` : ""}</div>`;
}

export function openReceipt(e: HistoryEntry): void {
  const r: Receipt | undefined = e.receipt;
  if (!r) return;
  const url = safeUrl(r.url);
  openSheet(
    `<span class="t12 dim">${esc(KIND[r.kind ?? ""] ?? "산 것")} · ${esc(e.seller ?? "판매자")}가 보낸 확인서</span>
     <div style="margin-top:12px">${ticket(r, e.seller ?? "")}</div>
     <div class="receipt-pay"><span>낸 돈</span><span>${usdc(e.amount)} USDC</span></div>
     ${url ? `<a class="btn btn-card press" style="margin-top:12px" href="${esc(url)}" target="_blank" rel="noopener noreferrer">판매자 확인서 원본 열기</a>` : ""}
     <div class="bottom-actions" style="padding-top:12px"><button class="btn btn-primary press" data-act="close">닫기</button></div>`,
    (sheet, close) => sheet.querySelector('[data-act="close"]')?.addEventListener("click", () => void close()),
    { label: "예약 상세" },
  );
}
