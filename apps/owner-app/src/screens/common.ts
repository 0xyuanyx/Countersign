import { CHAIN_NAME, CODE_TEXT, type HistoryEntry } from "../api.js";
import { app } from "../app.js";
import { esc, ic } from "../ui.js";

export function tabs(active: "home" | "activity" | "policy" | "settings"): string {
  const t = (key: typeof active, label: string, icon: string, badge = false) =>
    `<a class="tab" href="#/${key}" ${active === key ? 'aria-current="page"' : ""}>${icon}${badge ? '<span class="badge" aria-label="새 요청"></span>' : ""}${label}</a>`;
  return `<nav class="tabs" aria-label="탭">
    ${t("home", "홈", ic.home(), app.data.requests.length > 0)}
    ${t("activity", "내역", ic.list())}
    ${t("policy", "정책", ic.sliders())}
    ${t("settings", "설정", ic.gear())}
  </nav>`;
}

export function offlineBanner(): string {
  const d = app.data;
  if (!d.offline) return "";
  return `<div class="banner-off" role="status">${ic.wifiOff()}<span>${esc(d.offline)}. 다시 닿으면 바로 새로 고쳐요</span></div>`;
}

export function chainName(id?: number): string {
  return id === undefined ? "" : (CHAIN_NAME[id] ?? `체인 ${id}`);
}

/** 내역 한 줄의 짧은 설명 */
export function shortReason(e: HistoryEntry): string {
  if (e.status === "paid") return e.purpose ?? "결제";
  if (e.status === "pending") return "결제 전에 물어보는 중";
  if (e.status === "failed") return "HSP 단계에서 실패";
  if (e.code === "OVER_LIMIT" && e.reason) return e.reason;
  return CODE_TEXT[e.code ?? ""]?.short ?? e.reason ?? "거절됨";
}

export function statusWord(e: HistoryEntry): string {
  return { paid: "결제됨", rejected: "거절", pending: "확인 대기", failed: "실패" }[e.status];
}
