// 알림: 구매 요청과 막은 결제만 알린다 (결제 완료는 알리지 않음, design/README.md "추후 계획").
// 지금은 앱이 살아 있는 동안(다른 앱으로 넘어가 있어도) 새 항목을 찾아 서비스 워커로 알림을 띄운다.
// 앱이 완전히 꺼진 폰을 깨우는 서버 푸시(Web Push, VAPID)는 주인 API 쪽 작업이 필요하다 (README "알려진 한계").

import { app } from "./app.js";
import { CODE_TEXT } from "./api.js";
import { usdc } from "./ui.js";

const KEY = "cs.notified";
let primed = false;

export function notifySupported(): boolean {
  return "Notification" in window && "serviceWorker" in navigator;
}
export function notifyPermission(): NotificationPermission | "unsupported" {
  return notifySupported() ? Notification.permission : "unsupported";
}
export async function enableNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (!notifySupported()) return "unsupported";
  return Notification.requestPermission();
}

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function save(s: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...s].slice(-200)));
  } catch {
    /* 저장 못 해도 이번 실행 동안은 같은 알림을 다시 띄우지 않는다 */
  }
}

type Item = { id: string; title: string; body: string; url: string };

function items(): Item[] {
  const now = Date.now() / 1000;
  const reqs = app.data.requests
    .filter((r) => r.status === "pending")
    .map((r) => ({
      id: `req:${r.id}`,
      title: "구매 요청",
      body: `${r.reason === "unknown_seller" ? "처음 보는 판매자 " : ""}${r.seller}가 ${usdc(r.amount)} USDC를 청구했어요. 눌러서 확인해 주세요`,
      url: `#/req/${r.id}`,
    }));
  const blocks = app.data.history
    .filter((e) => e.status === "rejected" && e.code !== "OWNER_REJECTED" && now - e.at < 3600)
    .map((e) => ({
      id: `blk:${e.id}`,
      title: "결제를 막았어요",
      body:
        e.code === "PAYEE_MISMATCH"
          ? `${e.seller ?? "판매자"} 청구서의 받는 주소가 등록된 주소와 달라요. 돈은 나가지 않았어요`
          : `${e.seller ?? "판매자"} · ${CODE_TEXT[e.code ?? ""]?.short ?? "검증 실패"}. 돈은 나가지 않았어요`,
      url: `#/p/${e.id}`,
    }));
  return [...reqs, ...blocks];
}

/** 새로고침할 때마다 부른다. 앱 화면이 보이고 있으면 알림 대신 시트·카드로 보여 주므로 띄우지 않는다 */
export function checkNotifications(): void {
  const seen = load();
  const all = items();
  if (!primed) {
    primed = true;
    // 처음 켠 날 쌓여 있던 것까지 한꺼번에 울리지 않게
    if (seen.size === 0) {
      all.forEach((i) => seen.add(i.id));
      save(seen);
      return;
    }
  }
  const fresh = all.filter((i) => !seen.has(i.id));
  if (!fresh.length) return;
  fresh.forEach((i) => seen.add(i.id));
  save(seen);
  if (notifyPermission() !== "granted" || document.visibilityState === "visible") return;
  void navigator.serviceWorker.ready.then((reg) =>
    fresh.forEach((i) => reg.showNotification(i.title, { body: i.body, tag: i.id, icon: "/icon-192.png", badge: "/favicon-32.png", data: { url: i.url } })),
  );
}
