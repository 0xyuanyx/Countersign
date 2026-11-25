// 앱 껍데기만 캐시한다. /api 응답(잔액·내역·토큰이 쓰이는 요청)은 절대 캐시하지 않는다.
const CACHE = "countersign-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/favicon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // 네트워크 먼저, 안 되면 캐시 (오프라인에서도 앱은 열리고 "지갑 서버에 못 닿아요"를 보여 준다)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r ?? caches.match("/"))),
  );
});

// 알림을 누르면: 열린 앱이 있으면 그 화면으로 보내고(앱이 비밀번호 → 구매 요청 시트 / 거절 상세로), 없으면 앱을 연다
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const hash = (e.notification.data && e.notification.data.url) || "#/home";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const c = list[0];
      if (c) {
        c.postMessage({ type: "open", hash });
        return c.focus();
      }
      return self.clients.openWindow(new URL("/" + hash, self.registration.scope).href);
    }),
  );
});
