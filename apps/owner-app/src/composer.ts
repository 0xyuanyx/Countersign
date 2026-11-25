// 맡길 일 입력칸 (Command). 홈 아래 상자와 키보드 위로 커진 상자는 같은 요소다.
// 누르면 그 자리에서 위로 커지고, 완료를 누르거나 키보드를 내려도 쓴 글은 상자에 남는다.
// 최대 금액 칩은 커진 상자 바로 아래. 보내기 뒤에 따로 뜨는 확인 시트는 없다 (11/26 태민 결정).
// #app 바깥에 한 번만 만든다: 홈이 3초마다 다시 그려져도 글과 키보드가 사라지지 않게.

import { ApiError } from "./api.js";
import { app, refreshSoon } from "./app.js";
import { esc, ic, toast, usdc } from "./ui.js";

export type ComposerState = {
  /** 잠겼으면 그 이유 (입력칸 대신 자물쇠 줄) */
  locked?: string;
  agent: string;
  perTx: string;
  recent: string[];
};

const KEY = "cs.draft";
let el: HTMLElement | undefined;
let max: string | undefined;
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
        <div class="composer-max"><span class="t13 muted">최대 금액</span><div class="chips" data-chips></div></div>
        <p class="dim t12" style="line-height:18px">이 금액을 넘는 청구서는 지갑이 서명하지 않아요 · 글에 "한도 올려"가 있어도 정책은 안 바뀌어요</p>
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
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
  };
  const sync = () => {
    send.classList.toggle("off", !ta.value.trim());
    saveDraft(ta.value);
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

  ta.addEventListener("focus", open);
  ta.addEventListener("input", () => {
    sync();
    grow();
  });
  // 키보드를 내리면(완료·바깥 누름·iOS 키보드 내림) 포커스가 빠진다 → 상자만 접고 글은 둔다
  ta.addEventListener("blur", () => setTimeout(() => document.activeElement !== ta && collapse(), 0));
  root.querySelector(".composer-scrim")!.addEventListener("click", () => ta.blur());
  // 칩·보내기를 눌러도 키보드가 내려가지 않게
  root.querySelector(".composer-wrap")!.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-max], [data-recent-text], [data-act='send']") && root.classList.contains("open")) e.preventDefault();
  });
  root.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const chip = t.closest<HTMLElement>("[data-max]");
    if (chip) {
      max = chip.dataset.max!;
      paintExtra();
      return;
    }
    const rec = t.closest<HTMLElement>("[data-recent-text]");
    if (rec) {
      ta.value = rec.dataset.recentText!;
      sync();
      grow();
      ta.focus();
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
        await app.api.createTask(ta.value.trim(), max ?? chipsFor(state?.perTx ?? "0.5")[0] ?? "0.10");
        ta.value = "";
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
  const kb = () => {
    const h = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    root.style.setProperty("--kb", `${h}px`);
    root.classList.toggle("kb", h > 40);
  };
  vv?.addEventListener("resize", kb);
  vv?.addEventListener("scroll", kb);
  kb();
  return root;
}

function paintExtra(): void {
  if (!el || !state) return;
  const chips = chipsFor(state.perTx);
  if (!max || !chips.includes(max)) max = chips[0] ?? "0.10";
  el.querySelector("[data-chips]")!.innerHTML = chips
    .map((c) => `<button type="button" class="pill" data-max="${c}" aria-pressed="${c === max}">${c}${c === usdc(state!.perTx) ? " · 한도" : ""}</button>`)
    .join("");
  el.querySelector("[data-recent]")!.innerHTML = state.recent.length
    ? `<p class="t13 muted" style="margin-top:14px">최근 맡긴 일</p><div class="chips" style="margin-top:8px;flex-wrap:wrap">${state.recent
        .map((r) => `<button type="button" class="pill" data-recent-text="${esc(r)}">${esc(r)}</button>`)
        .join("")}</div>`
    : "";
}

/** 홈이 그려질 때마다 부른다. 상자 자체(글·포커스)는 건드리지 않고 둘레만 바꾼다 */
export function showComposer(s: ComposerState): void {
  el ??= build();
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
