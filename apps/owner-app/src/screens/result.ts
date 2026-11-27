// 끝난 일의 결과 (에이전트가 정리한 글). 에이전트 말풍선(날씨·옷차림·우산) + 고른 것 + 접힌 "다른 후보 n곳 · 탈락 이유".
// 비교는 표로 (고른 것 ✓ + 다른 후보), 그 아래 탈락 이유.

import type { HistoryEntry, PickOption, TaskResult } from "../api.js";
import { esc, ic } from "../ui.js";

const SKY: Record<string, string> = { sun: "맑음", cloud: "흐림", rain: "비", snow: "눈" };

function dayLabel(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${Number(m[2])}일` : date;
}

function facts(o: PickOption): string {
  return (o.facts ?? []).map((f) => `${f.label} ${f.value}`).join(" · ");
}

export function resultBlock(r: TaskResult | undefined, history: HistoryEntry[], key: string): string {
  if (!r) return "";
  const w = r.weather;
  let bubble = "";
  if (w) {
    const a = w.advice ?? {};
    const say = [a.clothing, a.note, a.umbrella === true ? "우산은 꼭 챙기세요." : a.umbrella === false ? "우산은 없어도 돼요." : ""]
      .map((x) => (x ?? "").trim())
      .filter(Boolean)
      .map((x) => (/[.!?]$/.test(x) ? x : `${x}.`))
      .join(" ");
    const days = w.days
      .map((d) => `${dayLabel(d.date)} ${SKY[d.sky ?? ""] ?? ""} ${d.high ?? "–"}° / ${d.low ?? "–"}°${d.rain_pct !== undefined && d.rain_pct >= 30 ? ` 비 ${d.rain_pct}%` : ""}`.replace(/\s+/g, " "))
      .join(" · ");
    bubble = `<div class="agent-say">
      <div class="who"><span class="av"><img src="/mark.svg" width="18" height="18" alt=""></span><span class="t13 muted">에이전트</span></div>
      <div class="bub">${say ? `<p>${esc(say)}</p>` : ""}<span class="wx">${esc(w.place)} · ${esc(days)}</span></div>
    </div>`;
  }
  const picks = (r.picks ?? [])
    .map((p, i) => {
      const c = p.chosen;
      const paid = c.history_id ? history.find((e) => e.id === c.history_id) : undefined;
      const others = p.others ?? [];
      const sub = c.detail || facts(c);
      return `<div class="pick">
        <span class="t12 dim">${esc(p.label)}${p.total ? ` · 후보 ${p.total}곳 중` : ""}</span>
        <div class="pick-chosen">
          <div class="stack"><span class="t17b">${esc(c.name)}</span>${sub ? `<span class="muted t13">${esc(sub)}</span>` : ""}${c.price ? `<span class="dim t12">${esc(c.price)} USDC</span>` : ""}</div>
          ${paid?.receipt ? `<button type="button" class="pill press" data-receipt="${esc(paid.id)}">상세보기</button>` : ""}
        </div>
        ${others.length ? compareTable(p.label, c, others, p.criteria, `pick:${key}:${i}`) : ""}
      </div>`;
    })
    .join("");
  return `${bubble}${picks}`;
}

/** 고른 것과 다른 후보를 표로 나란히, 그 아래 후보마다 탈락 이유 */
function compareTable(label: string, c: PickOption, others: (PickOption & { reason?: string })[], criteria: string[] | undefined, k: string): string {
  const all = [c, ...others];
  const cols: string[] = [];
  for (const o of all) for (const f of o.facts ?? []) if (!cols.includes(f.label)) cols.push(f.label);
  const price = all.some((o) => o.price);
  const val = (o: PickOption, col: string) => o.facts?.find((f) => f.label === col)?.value ?? "–";
  const n = 1 + cols.length + (price ? 1 : 0);
  const head = ["후보", ...cols, ...(price ? ["값"] : [])].map((h) => `<span class="th">${esc(h)}</span>`).join("");
  const row = (o: PickOption, chosen: boolean) =>
    [`${esc(o.name)}${chosen ? " ✓" : ""}`, ...cols.map((col) => esc(val(o, col))), ...(price ? [esc(o.price ?? "–")] : [])]
      .map((v) => `<span class="${chosen ? "td sel" : "td"}">${v}</span>`)
      .join("");
  return `<details class="pick-others" data-k="${esc(k)}"><summary class="press"><span>${esc(label)} 후보 ${all.length}곳 비교 · 탈락 이유</span><span class="dim">${ic.chevD()}</span></summary>
    <div class="cmp" style="grid-template-columns:minmax(0,1.4fr) repeat(${n - 1},minmax(0,1fr))">${head}${row(c, true)}${others.map((o) => row(o, false)).join("")}</div>
    ${others
      .filter((o) => o.reason)
      .map((o) => `<p class="why"><b>탈락</b> · ${esc(o.name)} · ${esc(o.reason!)}</p>`)
      .join("")}
    ${criteria?.length ? `<span class="t12 dim">비교한 것 · ${esc(criteria.join(" · "))}</span>` : ""}
  </details>`;
}
