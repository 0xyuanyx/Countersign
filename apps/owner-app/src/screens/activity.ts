// 내역: 맡긴 일 단위로 시간순. 누르면 그 일에서 생긴 결제가 펼쳐지고 다시 접힌다. 진행 중인 일은 기본으로 펼침.
// 대조 띠는 거절 행에만 (결제된 행은 띠 없이 깔끔하게).

import type { HistoryEntry, Task } from "../api.js";
import { app, strip, type Screen } from "../app.js";
import { dayLabel, esc, hhmm, ic, usdc } from "../ui.js";
import { offlineBanner, shortReason, tabs } from "./common.js";

type Group = { key: string; at: number; title: string; task?: Task; entries: HistoryEntry[] };

function groups(): Group[] {
  const { history, tasks } = app.data;
  const byTask = new Map<string, Group>();
  for (const t of tasks) byTask.set(t.id, { key: t.id, at: t.created_at, title: t.text, task: t, entries: [] });
  const loose: Group[] = [];
  for (const e of history) {
    const tid = e.task_id ?? tasks.find((t) => t.order_refs.includes(e.order_ref))?.id;
    const g = tid ? byTask.get(tid) : undefined;
    if (g) g.entries.push(e);
    else loose.push({ key: `e:${e.id}`, at: e.at, title: e.purpose ?? e.seller ?? "결제", entries: [e] });
  }
  return [...byTask.values(), ...loose].sort((a, b) => b.at - a.at);
}

function sum(es: HistoryEntry[]): number {
  return es.filter((e) => e.status === "paid").reduce((s, e) => s + Number(e.amount ?? 0), 0);
}

function groupStatus(g: Group): { dot: string; text: string; open: boolean } {
  const paid = sum(g.entries);
  const blocked = g.entries.filter((e) => e.status === "rejected").length;
  const pending = g.entries.some((e) => e.status === "pending" && app.data.requests.some((r) => r.id === e.request_id));
  const st = g.task?.status;
  if (pending) return { dot: "ask", text: "결제 전에 물어보는 중", open: true };
  if (st === "open" || st === "working") return { dot: "ask", text: `진행 중${blocked ? ` · ${blocked}건 막음` : ""}`, open: true };
  if (st === "cancelled") return { dot: "off", text: "그만둠", open: false };
  if (paid > 0) return { dot: "", text: blocked ? `끝 · ${blocked}건 막고 ${paid.toFixed(2)} 결제` : `끝 · ${paid.toFixed(2)} USDC`, open: false };
  const last = g.entries[0];
  if (st === "failed" || (last && last.status !== "paid")) return { dot: "bad", text: `못 함${last ? ` · ${shortReason(last)}` : ""}`, open: false };
  return { dot: "off", text: "아직 결제 없음", open: false };
}

function row(e: HistoryEntry): string {
  const rej = e.status !== "paid";
  return `<a href="#/p/${esc(e.id)}" class="pay-row ${rej ? "rej" : ""} ${!app.animated.has(`row:${e.id}`) && e.status === "rejected" && Date.now() / 1000 - e.at < 30 ? "flash" : ""}">
    <span class="stack"><span class="t15" style="font-weight:500">${esc(e.seller ?? "알 수 없는 판매자")}</span><span class="dim t13 ellipsis" style="${e.status === "rejected" ? "color:var(--bad-text)" : ""}">${hhmm(e.at)} · ${esc(shortReason(e))}</span></span>
    <span style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none">
      <span class="t15" style="${rej ? "color:var(--fg3)" : ""}">${rej ? "" : "−"}${usdc(e.amount)}</span>
      ${rej ? strip(e, { size: "mini" }) : ""}
    </span>
  </a>`;
}

export function activity(): Screen {
  const gs = groups();
  const today = gs.filter((g) => dayLabel(g.at) === "오늘");
  const spentToday = Number(app.data.policy?.spent_24h ?? 0);
  // 날짜별로 나눈다
  const sections = new Map<string, Group[]>();
  for (const g of gs) {
    const k = dayLabel(g.at);
    sections.set(k, [...(sections.get(k) ?? []), g]);
  }
  const groupHtml = (g: Group) => {
    const s = groupStatus(g);
    const waiting = g.task && (g.task.status === "open" || g.task.status === "working") && !g.entries.some((e) => e.status === "paid");
    const entries = [...g.entries].sort((a, b) => a.at - b.at);
    return `<details class="task" data-k="${esc(g.key)}" ${s.open ? "open" : ""}>
      <summary>
        <span class="time">${hhmm(g.at)}</span>
        <span class="stack"><span class="t15 ellipsis" style="font-weight:500">${esc(g.title)}</span><span class="t13 muted" style="display:flex;align-items:center;gap:6px"><span class="dot ${s.dot}" style="width:6px;height:6px"></span>${esc(s.text)}</span></span>
        <span class="chev">${ic.chevD()}</span>
      </summary>
      <div class="body">
        ${entries.map(row).join("")}
        ${waiting ? `<span class="dim t13" style="padding:4px 0">에이전트가 청구서를 받는 중</span>` : ""}
        ${!entries.length && !waiting ? `<span class="dim t13" style="padding:4px 0">결제 없음</span>` : ""}
      </div>
    </details>`;
  };
  const html = `
    <div class="screen with-tabs">
      <div class="topbar"><h1 class="title-md">결제 내역</h1><span class="live"><span class="dot ${app.data.offline ? "off" : ""}" style="width:6px;height:6px"></span>${app.data.offline ? "끊김" : "실시간"}</span></div>
      ${offlineBanner()}
      <div style="display:flex;justify-content:space-between;margin-top:16px;font-size:13px" class="muted">
        <span>오늘 · 맡긴 일 ${today.filter((g) => g.task).length}개</span><span>${spentToday.toFixed(2)} USDC 씀</span>
      </div>
      <div style="margin-top:4px">
        ${
          gs.length
            ? [...sections.entries()]
                .map(([day, list], i) => `${i > 0 ? `<div class="t13 dim" style="margin-top:20px">${esc(day)}</div>` : ""}${list.map(groupHtml).join("")}`)
                .join("")
            : `<div class="empty-state"><span class="t15" style="font-weight:500">아직 결제가 없어요</span><span class="dim t13" style="line-height:20px">아래 입력칸에 할 일을 적으면<br>에이전트가 결제할 때마다 여기 보여요</span></div>`
        }
      </div>
    </div>
    ${tabs("activity")}`;
  app.data.history.forEach((e) => app.animated.add(`row:${e.id}`));
  return { html };
}
