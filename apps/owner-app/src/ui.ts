// 화면 조각을 만드는 작은 도구들. 프레임워크 없이 문자열 템플릿 + 이벤트 위임으로 그린다.

/** 문자열 템플릿에서 값은 반드시 이걸로 감싼다 (판매자 이름·설명은 에이전트가 넣은 글이라 믿지 않는다) */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const svg = (body: string, size = 18, stroke = "currentColor", width = 1.5) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** lucide 모양 선 아이콘 (design/README.md: 18px, 선 1.5, 글자 색을 따름) */
export const ic = {
  back: (s = 22) => svg('<path d="M15 18l-6-6 6-6"/>', s),
  close: (s = 22) => svg('<path d="M18 6L6 18"/><path d="M6 6l12 12"/>', s),
  chevR: (s = 16, c = "#8A8A94") => svg('<path d="M9 6l6 6-6 6"/>', s, c),
  chevD: (s = 16, c = "#A0A0AA") => svg('<path d="M6 9l6 6 6-6"/>', s, c),
  check: (s = 16, c = "currentColor") => svg('<path d="M5 12.5l4 4L19 6.5"/>', s, c),
  agent: (s = 16) => svg('<path d="M5 12.5l4 4L19 6.5"/><path d="M5 20h14"/>', s, "#F7F7F9", 2),
  blocked: (s = 18, c = "#FF5C5C") => svg('<circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/>', s, c),
  ask: (s = 18, c = "#F5A524") => svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5h.01"/>', s, c),
  down: (s = 18) => svg('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>', s),
  stop: (s = 18) => svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', s),
  play: (s = 18) => svg('<path d="M7 5l12 7-12 7z"/>', s),
  msg: (s = 18) => svg('<path d="M4 6h16v10H8l-4 4z"/>', s, "#8A8A94"),
  up: (s = 18, c = "#0E0E10") => svg('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>', s, c, 1.75),
  home: (s = 22) => svg('<path d="M4 10.5L12 4l8 6.5V20h-5v-6H9v6H4z"/>', s),
  list: (s = 22) => svg('<path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>', s),
  sliders: (s = 22) => svg('<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h4"/><path d="M12 17h8"/><circle cx="10" cy="17" r="2"/>', s),
  // lucide "settings" (톱니바퀴)
  gear: (s = 22) =>
    svg(
      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
      s,
    ),
  lock: (s = 22) => svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', s),
  face: (s = 18) => svg('<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1"/><path d="M15 9.5v1"/><path d="M12 9.5v3.5h-1"/><path d="M9.5 15.5a3.5 3.5 0 0 0 5 0"/>', s),
  del: (s = 24) => svg('<path d="M20 6H9l-5 6 5 6h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z"/><path d="M16 10l-4 4"/><path d="M12 10l4 4"/>', s),
  retry: (s = 16) => svg('<path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 20v-5h5"/>', s, "#A0A0AA"),
  qr: (s = 72) => svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2z"/><path d="M18 18h2v2h-2z"/><path d="M14 18h2"/><path d="M18 14h2"/>', s, "#A0A0AA", 1.25),
  share: (s = 18) => svg('<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>', s),
  plusSq: (s = 18) => svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8"/><path d="M8 12h8"/>', s),
  plus: (s = 20) => svg('<path d="M12 5v14"/><path d="M5 12h14"/>', s),
  dots: (s = 18) => svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>', s),
  more: (s = 20) => svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>', s, "currentColor", 2),
  wifiOff: (s = 16) => svg('<path d="M2 2l20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 5.2-2.8"/><path d="M19 12.9a10 10 0 0 0-2.3-1.6"/><path d="M12 20h.01"/>', s),
};

/** 주소를 앞 7자리·가운데·뒤 6자리로 나눈다 (앞뒤는 파란색, 가운데는 흐리게) */
export function addrHtml(a: string, opts: { diffWith?: string; short?: boolean } = {}): string {
  const s = a ?? "";
  if (s.length < 16) return `<span class="addr">${esc(s)}</span>`;
  const head = s.slice(0, 7);
  const tail = s.slice(-6);
  const mid = s.slice(7, -6);
  if (opts.short) return `<span class="addr"><span class="end">${esc(head)}</span>…<span class="end">${esc(tail)}</span></span>`;
  if (opts.diffWith !== undefined) {
    // 다른 부분만 빨갛게. 앞뒤가 같은 바꿔치기 주소를 잡는 화면 (데모 핵심)
    const o = opts.diffWith.toLowerCase();
    const x = s.toLowerCase();
    let p = 0;
    while (p < x.length && x[p] === o[p]) p++;
    let q = 0;
    while (q < x.length - p && x[x.length - 1 - q] === o[o.length - 1 - q]) q++;
    if (p >= x.length) return `<span class="addr">${esc(s)}</span>`;
    return `<span class="addr">${esc(s.slice(0, p))}<span class="addr-diff">${esc(s.slice(p, s.length - q))}</span>${esc(s.slice(s.length - q))}</span>`;
  }
  return `<span class="addr"><span class="end">${esc(head)}</span><span class="mid">${esc(mid)}</span><span class="end">${esc(tail)}</span></span>`;
}

/** "0.1" → "0.10" (USDC 표시는 소수 둘째 자리까지, 더 긴 값은 그대로) */
export function usdc(v: string | undefined): string {
  if (v === undefined || v === "") return "—";
  const [i, f = ""] = v.split(".");
  return `${i}.${f.padEnd(2, "0")}`;
}

export function hhmm(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function hhmmss(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${hhmm(unixSec)}:${String(d.getSeconds()).padStart(2, "0")}`;
}
export function dayLabel(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "오늘";
  if (d.toDateString() === y.toDateString()) return "어제";
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 화면 전환: View Transitions가 있으면 120ms 겹쳐 사라짐, 없으면 그냥 바꾼다 */
export function transition(update: () => void): void {
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (d.startViewTransition && !reducedMotion() && document.visibilityState === "visible") {
    const t = d.startViewTransition(update) as { ready?: Promise<void>; finished?: Promise<void> };
    // 화면이 가려져 스냅샷을 못 찍으면 전환만 건너뛴다 (내용은 이미 바뀜)
    t.ready?.catch(() => {});
    t.finished?.catch(() => {});
  }
  else update();
}

let toastTimer: number | undefined;
export function toast(text: string): void {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = text;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 2600);
}

/** 끝날 때까지 떠 있는 "…하는 중" 토스트. 다음 toast()가 바꿔 끼운다 */
export function toastBusy(text: string): void {
  toast(text);
  clearTimeout(toastTimer);
  const el = document.querySelector(".toast");
  if (el) el.innerHTML = `<span class="spin"></span>${esc(text)}`;
  toastTimer = window.setTimeout(() => el?.remove(), 30_000);
}

/**
 * 비동기 동작 동안 버튼을 "…하는 중"으로 바꾸고 막는다. 버튼이 없으면(시트가 닫힌 뒤 등) 진행 토스트.
 * 끝나면 버튼을 되돌린다 (결과 토스트는 부른 쪽에서).
 */
export async function busy<T>(btn: HTMLElement | null | undefined, label: string, fn: () => Promise<T>): Promise<T> {
  if (!btn || !btn.isConnected) {
    toastBusy(label);
    try {
      return await fn();
    } finally {
      if (document.querySelector(".toast")?.querySelector(".spin")) document.querySelector(".toast")?.remove();
    }
  }
  const html = btn.innerHTML;
  btn.setAttribute("aria-busy", "true");
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${esc(label)}`;
  try {
    return await fn();
  } finally {
    btn.removeAttribute("aria-busy");
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
    btn.innerHTML = html;
  }
}

/** 숫자가 바뀔 때 400ms 동안 이전 값에서 새 값으로 센다 */
export function countTo(el: Element | null, from: number, to: number, digits = 2): void {
  if (!el) return;
  if (reducedMotion() || from === to) {
    el.textContent = to.toFixed(digits);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / 400);
    const e = 1 - Math.pow(1 - k, 4);
    el.textContent = (from + (to - from) * e).toFixed(digits);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
