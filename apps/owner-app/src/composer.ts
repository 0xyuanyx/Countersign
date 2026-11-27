// 맡길 일 입력칸 (Command). 홈 아래 상자와 키보드 위로 커진 상자는 같은 요소다.
// 누르면 그 자리에서 위로 커지고, 완료를 누르거나 키보드를 내려도 쓴 글은 상자에 남는다.
// 최대 금액 칩은 커진 상자 바로 아래. 보내기 뒤에 따로 뜨는 확인 시트는 없다 (11/26 태민 결정).
// #app 바깥에 한 번만 만든다: 홈이 3초마다 다시 그려져도 글과 키보드가 사라지지 않게.

import { ApiError, type CatalogChip } from "./api.js";
import { app, refreshSoon } from "./app.js";
import { busy, esc, ic, toast, usdc } from "./ui.js";

export type ComposerState = {
  /** 잠겼으면 그 이유 (입력칸 대신 자물쇠 줄) */
  locked?: string;
  agent: string;
  perTx: string;
  recent: string[];
};

const KEY = "cs.draft";
/** 입력칸이 비어 있을 때 보여 주는 추천. 지갑 서버의 /api/catalog(판매 서버 상품)에서, 못 받으면 아래 기본값 */
const SUGGEST: CatalogChip[] = [
  { id: "d1", label: "내일 서울 날씨 예보 사 와", task_text: "내일 서울 날씨 예보 사 와", scenario: "normal" },
  { id: "d2", label: "오늘 원·달러 환율 데이터 사 와", task_text: "오늘 원·달러 환율 데이터 사 와", scenario: "normal" },
  { id: "d3", label: "오늘 주요 뉴스 요약 사 와", task_text: "오늘 주요 뉴스 요약 사 와", scenario: "normal" },
];
let catalogFor: string | undefined;
let catalogChips: CatalogChip[] = SUGGEST;
/** 에이전트가 바뀌었을 때만 다시 받는다 */
function loadCatalog(): void {
  const key = `${app.api.mock}:${app.api.agentId ?? ""}`;
  if (catalogFor === key) return;
  catalogFor = key;
  void app.api
    .catalog()
    .then((c) => {
      if (c.length) catalogChips = c;
      paintExtra();
    })
    .catch(() => {});
}
let el: HTMLElement | undefined;
let max: string | undefined;
/** 추천 칩이 준 일 전체 예산 (최대 금액 칩에 "추천"으로 더한다) */
let suggestedMax: string | undefined;
let state: ComposerState | undefined;

function loadDraft(): string {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}
function saveDraft(v: string): void {
  try {
    if (v) sessionStorage.setItem(KEY, v);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* 저장 못 해도 화면에는 남는다 */
  }
}

function chipsFor(perTx: string): string[] {
  return ["0.10", "0.25", usdc(perTx)].filter((v, i, a) => a.indexOf(v) === i && Number(v) <= Number(perTx));
}

function build(): HTMLElement {
  const root = document.createElement("div");
  root.id = "composer";
  root.className = "composer";
  root.hidden = true;
  root.innerHTML = `
    <div class="composer-scrim"></div>
    <div class="composer-wrap">
      <div class="composer-head">
        <span class="stack"><span class="t15b">에이전트에게 맡기기</span><span class="dim t12" data-agent></span></span>
        <button type="button" class="pill" data-act="done">완료</button>
      </div>
      <div class="composer-lock" data-lock>${ic.lock(18)}<span class="dim" data-lock-text></span></div>
      <div class="composer-box" data-box>
        <span class="composer-ic">${ic.msg()}</span>
        <textarea rows="1" maxlength="2000" placeholder="에이전트에게 맡길 일" aria-label="에이전트에게 맡길 일" enterkeyhint="enter"></textarea>
        <button type="button" class="send-ic off" data-act="send" aria-label="보내기">${ic.up()}</button>
      </div>
      <div class="composer-extra">
        <div class="composer-max"><span class="t13 muted">이 일에 쓸 최대</span><div class="chips" data-chips></div></div>
        <p class="dim t12" style="line-height:18px">이 금액을 넘으면 지갑이 서명하지 않아요 · 글로는 정책이 안 바뀌어요</p>
        <div data-suggest></div>
        <div data-recent></div>
      </div>
    </div>`;
  document.body.append(root);

  const ta = root.querySelector("textarea")!;
  const send = root.querySelector<HTMLButtonElement>('[data-act="send"]')!;
  ta.value = loadDraft();

  const grow = () => {
    if (!root.classList.contains("open")) {
      ta.style.height = "";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.3))}px`;
  };
  const sync = () => {
    send.classList.toggle("off", !ta.value.trim());
    saveDraft(ta.value);
    const sg = root.querySelector<HTMLElement>("[data-suggest]");
    if (sg) sg.hidden = !!ta.value.trim();
  };
  sync();

  const open = () => {
    if (root.classList.contains("open")) return;
    root.classList.add("open");
    paintExtra();
    grow();
  };
  const collapse = () => {
    root.classList.remove("open");
    ta.scrollTop = 0;
    grow();
  };

  ta.addEventListener("focus", () => {
    open();
    // 키보드가 다 올라온 뒤 높이를 다시 잰다 (아이폰은 resize가 늦거나 한 번만 온다)
    for (const ms of [120, 350, 700]) setTimeout(kb, ms);
  });
  ta.addEventListener("input", () => {
    sync();
    grow();
  });
  // 키보드를 내리면(완료·바깥 누름·iOS 키보드 내림) 포커스가 빠진다 → 상자만 접고 글은 둔다
  // 칩을 누르는 중이면(아이폰은 버튼을 눌러도 포커스가 빠진다) 접지 않고 바로 다시 포커스한다
  let holding = 0;
  ta.addEventListener("blur", () =>
    setTimeout(() => {
      if (document.activeElement === ta) return;
      if (Date.now() - holding < 600 && root.classList.contains("open")) return;
      collapse();
    }, 0),
  );
  root.querySelector(".composer-scrim")!.addEventListener("click", () => ta.blur());
  // 칩·보내기를 눌러도 키보드가 내려가지 않게
  // pointerdown만 막으면 아이폰 Safari는 mousedown에서 포커스를 옮겨 키보드를 내린다 → 셋 다 막는다
  const KEEP = "[data-max], [data-recent-text], [data-act='send'], summary";
  for (const ev of ["pointerdown", "mousedown"] as const)
    root.querySelector(".composer-wrap")!.addEventListener(ev, (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(KEEP) && root.classList.contains("open")) {
        holding = Date.now();
        e.preventDefault();
      }
    });
  root.querySelector(".composer-wrap")!.addEventListener(
    "touchstart",
    (e) => {
      if ((e.target as HTMLElement).closest(KEEP) && root.classList.contains("open")) holding = Date.now();
    },
    { passive: true },
  );
  /** 칩을 누른 뒤 키보드가 내려갔으면 바로 다시 올린다 (누른 손가락 동작 안이라 아이폰도 허락함) */
  const keepFocus = () => {
    if (root.classList.contains("open") && document.activeElement !== ta) ta.focus({ preventScroll: true });
  };
  root.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const chip = t.closest<HTMLElement>("[data-max]");
    if (chip) {
      max = chip.dataset.max!;
      paintExtra();
      keepFocus();
      return;
    }
    if (t.closest("summary")) return void setTimeout(keepFocus, 0);
    const rec = t.closest<HTMLElement>("[data-recent-text]");
    if (rec) {
      ta.value = rec.dataset.recentText!;
      suggestedMax = rec.dataset.suggestMax ? usdc(rec.dataset.suggestMax) : undefined;
      if (suggestedMax) {
        max = suggestedMax;
        paintExtra();
      }
      sync();
      grow();
      ta.focus({ preventScroll: true });
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "done") {
      ta.blur();
      collapse();
    }
    if (act === "send") {
      if (!root.classList.contains("open") || !ta.value.trim()) return void ta.focus();
      send.disabled = true;
      try {
        const text = ta.value.trim();
        await busy(send, "", () => app.api.createTask(text, max ?? chipsFor(state?.perTx ?? "0.5")[0] ?? "0.10"));
        ta.value = "";
        suggestedMax = undefined;
        max = undefined;
        sync();
        ta.blur();
        collapse();
        toast("맡겼어요 · 내역에서 진행을 볼 수 있어요");
        refreshSoon();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : "맡기지 못했어요");
      }
      send.disabled = false;
    }
  });

  // 키보드 높이만큼 커진 상자를 올린다 (visualViewport가 없으면 화면 아래)
  const vv = window.visualViewport;
  function kb(): void {
    const h = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    root.style.setProperty("--kb", `${h}px`);
    // 보이는 높이: 커진 상자가 이보다 크면 아래(추천·최근)만 스크롤 → 키보드 위 막대에 가리지 않는다
    root.style.setProperty("--vvh", `${vv ? vv.height : window.innerHeight}px`);
    root.classList.toggle("kb", h > 40);
  }
  vv?.addEventListener("resize", kb);
  vv?.addEventListener("scroll", kb);
  kb();
  return root;
}

function paintExtra(): void {
  if (!el || !state) return;
  const base = chipsFor(state.perTx);
  const chips = suggestedMax && !base.includes(suggestedMax) ? [...base, suggestedMax] : base;
  if (!max || !chips.includes(max)) max = chips[0] ?? "0.10";
  el.querySelector("[data-chips]")!.innerHTML = chips
    .map((c) => `<button type="button" class="pill" data-max="${c}" aria-pressed="${c === max}">${c}${c === suggestedMax ? " · 추천" : c === usdc(state!.perTx) ? " · 한도" : ""}</button>`)
    .join("");
  const sg = el.querySelector<HTMLElement>("[data-suggest]")!;
  // 정상 칩 3개를 먼저, 공격 칩은 "공격 시험해 보기"에 시나리오마다 하나씩 접어 둔다 (데모용)
  // 비교해서 고르는 일(compare, 출장 비서)을 앞에, 그다음 정상 구매. 둘 다 "맡겨 보세요"에 3개까지
  const SAFE = ["compare", "normal"];
  const normal = [...catalogChips.filter((c) => c.scenario === "compare"), ...catalogChips.filter((c) => c.scenario === "normal")].slice(0, 3);
  const seen = new Set<string>();
  const attacks = catalogChips.filter((c) => !SAFE.includes(c.scenario) && !seen.has(c.scenario) && seen.add(c.scenario));
  const chip = (c: CatalogChip, tag = false) =>
    `<button type="button" class="pill" data-recent-text="${esc(c.task_text)}"${c.suggested_max_amount ? ` data-suggest-max="${esc(c.suggested_max_amount)}"` : ""}>${esc(c.label)}${tag && c.scenario_label ? ` <span class="dim">· ${esc(c.scenario_label)}</span>` : ""}</button>`;
  sg.innerHTML = `<p class="t13 muted" style="margin-top:14px">이런 일을 맡겨 보세요</p><div class="chips" style="margin-top:8px;flex-wrap:wrap">${(normal.length ? normal : catalogChips.slice(0, 3)).map((c) => chip(c)).join("")}</div>${
    attacks.length
      ? `<details class="more-tasks" style="margin-top:6px"><summary><span class="t13 muted">공격 시험해 보기 · 지갑이 막는지 보기</span><span class="dim">${ic.chevD()}</span></summary><div class="chips" style="margin-top:4px;flex-wrap:wrap">${attacks.map((c) => chip(c, true)).join("")}</div></details>`
      : ""
  }`;
  sg.hidden = !!el.querySelector("textarea")!.value.trim();
  el.querySelector("[data-recent]")!.innerHTML = state.recent.length
    ? `<p class="t13 muted" style="margin-top:14px">최근 맡긴 일</p><div class="chips" style="margin-top:8px;flex-wrap:wrap">${state.recent
        .map((r) => `<button type="button" class="pill" data-recent-text="${esc(r)}">${esc(r)}</button>`)
        .join("")}</div>`
    : "";
}

/** 홈이 그려질 때마다 부른다. 상자 자체(글·포커스)는 건드리지 않고 둘레만 바꾼다 */
export function showComposer(s: ComposerState): void {
  el ??= build();
  loadCatalog();
  state = s;
  el.hidden = false;
  el.classList.toggle("locked", !!s.locked);
  el.querySelector("[data-lock-text]")!.textContent = s.locked ?? "";
  el.querySelector("[data-agent]")!.textContent = s.agent;
  if (s.locked) el.querySelector("textarea")!.blur();
  if (el.classList.contains("open")) paintExtra();
}

/** 홈이 아닌 화면에서는 숨긴다 (쓴 글은 남겨 둠) */
export function hideComposer(): void {
  if (!el || el.hidden) return;
  el.querySelector("textarea")!.blur();
  el.classList.remove("open");
  el.hidden = true;
}
