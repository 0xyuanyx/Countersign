// 앱에 들어오기 전 화면: 스플래시 → (브라우저면) 홈 화면 추가 안내 → 지갑과 연결(QR) → 비밀번호 만들기 → (다음부터는) 잠금

import { mountIconAnimation } from "../icon-animation.js";
import { ApiError, HttpOwnerApi } from "../api.js";
import { checkPin, createPasskey, isIOS, isMobile, parsePairing, passkeySupported, setPin, store, verifyPasskey, type Pairing } from "../auth.js";
import { esc, ic, reducedMotion, transition } from "../ui.js";

const root = () => document.getElementById("app")!;

/** 로고 마크 (정지 화면용 끝 모양) */
export function logoMark(size = 32, cls = ""): string {
  return `<span class="${cls}" style="display:inline-flex;width:${size}px;height:${size}px"><img src="/favicon.svg" width="${size}" height="${size}" alt=""></span>`;
}

// ─── 스플래시 ───
// 태민이 만든 로고 영상(design/brand/animation/icon-animation.webm·mp4, 11/25)을 튼다.
// 영상은 3.6초인데 움직임은 0.5~2.1초 구간이라, 앞 0.4초를 건너뛰고 2.45초에서 다음 화면으로 넘긴다.
// 영상을 못 틀면(저전력 모드의 자동재생 막힘 등) 같은 모양의 코드 애니메이션(icon-animation.js)으로 대신한다.
const SPLASH = { from: 0.4, wordAt: 1.6, until: 2.45 };

export function splash(): Promise<void> {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "splash";
    el.innerHTML = `<div class="splash-logo"></div><span class="word">Countersign</span>`;
    document.body.append(el);
    const box = el.querySelector<HTMLElement>(".splash-logo")!;
    const word = el.querySelector(".word")!;
    let finished = false;
    let fallback = false;
    const done = () => {
      if (finished) return;
      finished = true;
      // 로고가 왼쪽 위로 작아지며 다음 화면으로 (View Transitions 공유 요소). 지원 안 하면 살짝 사라짐
      transition(() => el.remove());
      resolve();
    };

    const codeAnimation = () => {
      if (fallback || finished) return;
      fallback = true;
      box.querySelector("video")?.pause();
      box.innerHTML = "";
      const anim = mountIconAnimation(box, { size: 168, autoplay: false, background: false });
      if (reducedMotion()) {
        anim.seek(1);
        word.classList.add("on");
        setTimeout(done, 300);
        return;
      }
      setTimeout(() => word.classList.add("on"), 1100);
      void anim.play().then(() => setTimeout(done, 350));
    };

    if (reducedMotion()) return codeAnimation();

    const video = document.createElement("video");
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.preload = "auto";
    video.width = 168;
    video.height = 168;
    video.setAttribute("aria-label", "Countersign");
    video.style.cssText = "display:block;width:168px;height:168px;object-fit:contain";
    // 사파리(아이폰)는 webm을 "재생할 수 있다"고 답하고도 제대로 못 틀 때가 있어 mp4(H.264)를 먼저 준다
    video.innerHTML = isIOS() || /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
      ? `<source src="/splash/icon-animation.mp4" type="video/mp4">`
      : `<source src="/splash/icon-animation.webm" type="video/webm"><source src="/splash/icon-animation.mp4" type="video/mp4">`;
    box.append(video);

    let started = false;
    const giveUp = setTimeout(() => !started && codeAnimation(), 1200);
    // 마지막 후보(mp4)까지 못 읽으면 코드 애니메이션으로
    video.querySelector("source:last-child")?.addEventListener("error", () => !started && (clearTimeout(giveUp), codeAnimation()));
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = SPLASH.from;
      video.play().then(
        () => {
          started = true;
          clearTimeout(giveUp);
        },
        () => {
          clearTimeout(giveUp);
          codeAnimation();
        },
      );
    });
    video.addEventListener("timeupdate", () => {
      if (fallback) return;
      if (video.currentTime >= SPLASH.wordAt) word.classList.add("on");
      if (video.currentTime >= SPLASH.until) {
        video.pause();
        done();
      }
    });
    video.addEventListener("ended", () => !fallback && done());
  });
}

// ─── 숫자 키패드 (비밀번호 만들기·잠금 공용) ───
function keypad(): string {
  const k = (n: string) => `<button type="button" class="key" data-key="${n}">${n}</button>`;
  return `<div class="keypad">${["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(k).join("")}<span></span>${k("0")}
    <button type="button" class="key" data-key="del" aria-label="지우기">${ic.del()}</button></div>`;
}
function dots(n: number): string {
  return `<div class="pin-dots" role="status" aria-label="6자리 중 ${n}자리 입력">${Array.from({ length: 6 }, (_, i) => `<span class="${i < n ? "on" : ""}"></span>`).join("")}</div>`;
}

/** 키패드 입력을 받는다. 6자리가 차면 onFull. 실물 키보드 숫자도 받는다 */
function bindPad(scope: HTMLElement, onChange: (v: string) => void, onFull: (v: string) => void): { reset: () => void; destroy: () => void } {
  let v = "";
  let busy = false;
  const press = (key: string) => {
    if (busy) return;
    if (key === "del") v = v.slice(0, -1);
    else if (/^\d$/.test(key) && v.length < 6) v += key;
    else return;
    onChange(v);
    if (v.length === 6) {
      busy = true;
      setTimeout(() => onFull(v), 120);
    }
  };
  scope.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
    if (b) press(b.dataset.key!);
  });
  const onKey = (e: KeyboardEvent) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === "Backspace") press("del");
  };
  window.addEventListener("keydown", onKey);
  return {
    reset: () => {
      v = "";
      busy = false;
      onChange(v);
    },
    destroy: () => window.removeEventListener("keydown", onKey),
  };
}

function shake(scope: HTMLElement): void {
  const d = scope.querySelector(".pin-dots");
  d?.classList.remove("shake");
  void (d as HTMLElement | null)?.offsetWidth;
  d?.classList.add("shake");
  navigator.vibrate?.(60);
}

// ─── 홈 화면 추가 안내 (처음 실행, 브라우저로 열었을 때) ───
let deferredInstall: (Event & { prompt: () => Promise<void> }) | undefined;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e as typeof deferredInstall;
});

export function installGuide(opts: { hadPairLink: boolean; closable?: boolean }): Promise<"continue" | "closed"> {
  return new Promise((resolve) => {
    let os: "ios" | "android" = isIOS() ? "ios" : "android";
    const steps = () =>
      os === "ios"
        ? [
            `아래쪽 ${ic.share(16)} 공유 버튼을 눌러요`,
            `<b>홈 화면에 추가</b>를 눌러요`,
            `홈 화면의 Countersign을 열고, 거기서 지갑 QR을 찍어요`,
          ]
        : [
            `오른쪽 위 ${ic.dots(16)} 메뉴를 눌러요`,
            `<b>홈 화면에 추가</b> 또는 <b>앱 설치</b>를 눌러요`,
            `홈 화면의 Countersign을 열고, 거기서 지갑 QR을 찍어요`,
          ];
    const draw = () => {
      root().innerHTML = `
      <div class="screen">
        <div class="topbar">
          ${opts.closable ? `<button class="icon-btn" data-act="close" aria-label="닫기">${ic.close()}</button>` : `<span style="display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600">${logoMark(28, "brand-logo")}Countersign</span>`}
          <span></span>
        </div>
        <h1 class="title-md" style="margin-top:28px">홈 화면에 추가해 주세요</h1>
        <p class="muted" style="margin-top:10px;line-height:22px">알림을 받고 앱처럼 쓰려면 홈 화면에 있어야 해요.${
          os === "ios" ? " 아이폰은 Safari와 홈 화면 앱이 저장소를 따로 써서, 연결은 홈 화면 앱에서 해요" : ""
        }</p>
        ${isMobile() ? "" : `<p class="dim t13" style="margin-top:8px;line-height:20px">폰에서 이 주소를 열어 홈 화면에 추가해 주세요 · 컴퓨터에서는 아래 "이 브라우저에서 계속"으로 둘러볼 수 있어요</p>`}
        ${opts.hadPairLink ? `<div class="banner-off">${ic.qr(18)}<span>QR은 확인했어요. 홈 화면 앱을 연 뒤 한 번 더 찍어 주세요</span></div>` : ""}
        <div class="seg" role="group" aria-label="폰 종류">
          <button type="button" data-os="ios" aria-pressed="${os === "ios"}">아이폰</button>
          <button type="button" data-os="android" aria-pressed="${os === "android"}">안드로이드</button>
        </div>
        <div class="steps">${steps()
          .map((s, i) => `<div class="step"><span class="n">${i + 1}</span><span style="padding-top:3px;line-height:22px">${s}</span></div>`)
          .join("")}</div>
        <div class="bottom-actions">
          ${os === "android" && deferredInstall ? `<button class="btn btn-primary press" data-act="install">앱 설치</button>` : ""}
          ${opts.closable ? "" : `<button class="btn btn-ghost" data-act="continue">이 브라우저에서 계속</button>`}
        </div>
      </div>`;
    };
    draw();
    const onClick = async (e: Event) => {
      const t = e.target as HTMLElement;
      const osBtn = t.closest<HTMLElement>("[data-os]");
      if (osBtn) {
        os = osBtn.dataset.os as typeof os;
        draw();
        return;
      }
      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "install" && deferredInstall) {
        await deferredInstall.prompt();
        deferredInstall = undefined;
        draw();
      } else if (act === "continue" || act === "close") {
        root().removeEventListener("click", onClick);
        resolve(act === "close" ? "closed" : "continue");
      }
    };
    root().addEventListener("click", onClick);
  });
}

// ─── 지갑과 연결 (가입 없음, QR 또는 연결 코드) ───
export function pairScreen(prefill?: Pairing): Promise<Pairing> {
  return new Promise((resolve) => {
    let mode: "intro" | "scan" | "code" = "intro";
    let error = "";
    let busy = false;
    let stopCam: (() => void) | undefined;

    const draw = () => {
      root().innerHTML = `
      <div class="screen" style="position:relative">
        <div class="topbar">
          <span style="display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600">${logoMark(28, "brand-logo")}Countersign</span>
          <span class="t13 dim">1 / 2</span>
        </div>
        <h1 style="margin-top:28px;font-size:26px;line-height:1.3;font-weight:600">에이전트는 속아도<br>지갑은 안 속아요</h1>
        <p class="muted" style="margin-top:10px;line-height:22px">먼저 지갑 서버와 이 폰을 연결해요. 가입은 필요 없어요</p>
        ${
          mode === "code"
            ? `<div style="margin-top:28px;display:flex;flex-direction:column;gap:10px">
                <label class="t13 dim" for="pair-code">연결 코드 (지갑 서버 화면의 QR 아래 주소)</label>
                <input id="pair-code" class="field mono" style="font-size:13px" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…/#pair=…">
              </div>`
            : `<div class="scan-box">
                <span class="corner c1"></span><span class="corner c2"></span><span class="corner c3"></span><span class="corner c4"></span>
                ${mode === "scan" ? `<video playsinline muted></video>` : ic.qr()}
              </div>
              <p class="muted t13" style="margin-top:16px;text-align:center;line-height:21px">${
                busy && mode === "scan"
                  ? "QR을 읽었어요 · 지갑 서버에 연결하는 중"
                  : mode === "scan"
                    ? "지갑 서버 화면의 QR을 네모 안에 맞춰 주세요 · 15~30cm 떨어져서"
                    : "지갑 서버를 켜면 화면에 QR이 떠요<br>카메라로 찍으면 바로 연결돼요"
              }</p>`
        }
        <p class="err-text" style="margin-top:12px;text-align:center;min-height:20px" role="alert">${esc(error)}</p>
        <div class="bottom-actions">
          ${
            mode === "code"
              ? `<button class="btn btn-primary press" data-act="submit" ${busy ? "disabled" : ""}>${busy ? "확인 중…" : "연결"}</button>
                 <button class="btn btn-ghost" data-act="intro">QR로 찍기</button>`
              : `<button class="btn btn-primary press" data-act="scan" ${mode === "scan" ? "disabled" : ""}>${busy ? "확인 중…" : mode === "scan" ? "찍는 중…" : "QR 찍기"}</button>
                 <button class="btn btn-ghost" data-act="code">연결 코드로 입력</button>`
          }
          <button class="btn btn-ghost t13" style="height:40px;font-size:13px;color:var(--fg3)" data-act="demo">지갑 없이 데모로 둘러보기</button>
        </div>
      </div>`;
    };

    const attempt = async (p: Pairing | undefined) => {
      if (!p) {
        error = "연결 코드 모양이 아니에요";
        draw();
        return;
      }
      busy = true;
      error = "";
      draw();
      try {
        await new HttpOwnerApi(p.base, p.token).verify();
        stopCam?.();
        cleanup();
        resolve(p);
      } catch (e) {
        busy = false;
        // QR은 읽었는데 서버에 못 닿은 경우를 QR 문제와 구분해서 알려 준다
        const host = p.base ? new URL(p.base).host : location.host;
        error =
          e instanceof ApiError && e.status === 0
            ? `QR은 읽었어요 · ${host}에 닿지 않아요. 맥의 지갑 서버와 터널이 켜져 있는지 확인해 주세요`
            : e instanceof ApiError
              ? e.message
              : "연결하지 못했어요";
        if (mode === "scan") mode = "intro";
        draw();
      }
    };

    const startScan = async () => {
      mode = "scan";
      error = "";
      draw();
      const video = root().querySelector("video")!;
      try {
        // 매칭 QR은 주소·토큰이 들어가 촘촘하다 → 카메라를 높은 해상도로 연다
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        video.srcObject = stream;
        await video.play();
        let alive = true;
        stopCam = () => {
          alive = false;
          stream.getTracks().forEach((t) => t.stop());
        };
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const BD = (window as unknown as { BarcodeDetector?: new (o: object) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
        const detector = BD ? new BD({ formats: ["qr_code"] }) : undefined;
        const jsQR = detector ? undefined : (await import("jsqr")).default;
        let scanFrame = 0;
        const tick = async () => {
          if (!alive) return;
          let text: string | undefined;
          if (video.videoWidth) {
            if (detector) text = (await detector.detect(video).catch(() => []))[0]?.rawValue;
            else if (jsQR) {
              // 아이폰(BarcodeDetector 없음): 가운데 정사각형을 줄이지 않고(최대 1080) 읽는다.
              // 480으로 줄이면 촘촘한 매칭 QR(주소·토큰)의 칸이 뭉개져 못 읽는다. 어두운 터미널용으로 반전도 시도
              // 세 가지를 번갈아 시도: 원본 크기, 반전(어두운 터미널), 작게 줄인 것(QR이 크게 찍혀 흐릿할 때)
              const vw = video.videoWidth;
              const vh = video.videoHeight;
              const side = Math.min(vw, vh);
              const kind = scanFrame++ % 3;
              const out = kind === 2 ? Math.min(side, 600) : Math.min(side, 1080);
              canvas.width = out;
              canvas.height = out;
              ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, out, out);
              text = jsQR(ctx.getImageData(0, 0, out, out).data, out, out, { inversionAttempts: kind === 1 ? "onlyInvert" : "dontInvert" })?.data;
            }
          }
          const p = text ? parsePairing(text) : undefined;
          if (p) {
            stopCam?.();
            navigator.vibrate?.(30);
            void attempt(p);
          } else setTimeout(tick, 120);
        };
        void tick();
      } catch {
        mode = "intro";
        error = "카메라를 열 수 없어요. 연결 코드로 입력해 주세요";
        draw();
      }
    };

    const onClick = (e: Event) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (!act || busy) return;
      if (act === "scan") void startScan();
      if (act === "code" || act === "intro") {
        stopCam?.();
        mode = act;
        error = "";
        draw();
        if (act === "code") root().querySelector<HTMLInputElement>("#pair-code")?.focus();
      }
      if (act === "submit") void attempt(parsePairing(root().querySelector<HTMLInputElement>("#pair-code")?.value ?? ""));
      if (act === "demo") {
        stopCam?.();
        cleanup();
        resolve({ base: "", token: "", label: "데모", mock: true });
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && mode === "code") void attempt(parsePairing(root().querySelector<HTMLInputElement>("#pair-code")?.value ?? ""));
    };
    const cleanup = () => {
      root().removeEventListener("click", onClick);
      root().removeEventListener("keydown", onKey);
    };
    root().addEventListener("click", onClick);
    root().addEventListener("keydown", onKey);
    draw();
    if (prefill) void attempt(prefill);
  });
}

// ─── 비밀번호 만들기 → 확인 → Face ID ───
export function pinSetup(label: string): Promise<void> {
  return new Promise((resolve) => {
    let first = "";
    let msg = "다 누르면 한 번 더 확인하고, Face ID를 켤지 물어봐요";
    let err = false;
    const draw = (n = 0) => {
      root().innerHTML = `
      <div class="pin-screen">
        <div class="topbar"><span></span><span class="t13 dim">2 / 2</span></div>
        <span class="conn-chip" style="margin-top:32px"><span class="dot"></span>${esc(label)} 연결됨</span>
        <h1 class="title-sm" style="margin-top:24px">${first ? "한 번 더 눌러 주세요" : "앱 비밀번호 6자리를 만들어 주세요"}</h1>
        <p class="muted t13" style="margin-top:8px;text-align:center;line-height:21px;font-size:14px">앱을 열 때, 정책을 바꾸거나<br>구매를 승인할 때 물어봐요</p>
        ${dots(n)}
        <p class="pin-msg ${err ? "err" : ""}">${esc(msg)}</p>
        ${keypad()}
      </div>`;
    };
    draw();
    const pad = bindPad(
      root(),
      (v) => root().querySelectorAll(".pin-dots span").forEach((s, i) => s.classList.toggle("on", i < v.length)),
      async (v) => {
        if (!first) {
          first = v;
          msg = "";
          err = false;
          draw();
          pad.reset();
          return;
        }
        if (v !== first) {
          first = "";
          msg = "두 번 누른 숫자가 달라요. 처음부터 다시 만들어 주세요";
          err = true;
          draw();
          shake(root());
          pad.reset();
          return;
        }
        await setPin(v);
        pad.destroy();
        if (passkeySupported()) await askPasskey();
        resolve();
      },
    );
  });
}

function askPasskey(): Promise<void> {
  return new Promise((resolve) => {
    root().innerHTML = `
    <div class="pin-screen">
      <div class="topbar"><span></span><span></span></div>
      <span style="margin-top:96px;width:56px;height:56px;border-radius:28px;background:var(--card);display:flex;align-items:center;justify-content:center">${ic.face(26)}</span>
      <h1 class="title-sm" style="margin-top:20px">Face ID도 켤까요?</h1>
      <p class="muted" style="margin-top:8px;text-align:center;line-height:22px;font-size:14px">비밀번호 대신 얼굴(또는 지문)로 열 수 있어요.<br>비밀번호는 그대로 쓸 수 있어요</p>
      <p class="err-text" style="margin-top:12px;min-height:20px" role="alert"></p>
      <div class="bottom-actions" style="align-self:stretch">
        <button class="btn btn-primary press" data-act="on">Face ID 켜기</button>
        <button class="btn btn-ghost" data-act="skip">나중에</button>
      </div>
    </div>`;
    const onClick = async (e: Event) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "skip") {
        root().removeEventListener("click", onClick);
        resolve();
      } else if (act === "on") {
        if (await createPasskey()) {
          root().removeEventListener("click", onClick);
          resolve();
        } else root().querySelector(".err-text")!.textContent = "켜지 못했어요. 설정에서 다시 켤 수 있어요";
      }
    };
    root().addEventListener("click", onClick);
  });
}

// ─── 잠금: 앱 열 때, 그리고 정책 바꾸기·구매 승인·정지 풀기 때마다 ───
// 부른 화면이 제목·설명을 넘긴다. 닫기(✕)를 누르면 false (부른 화면으로 돌아감)

export function unlock(opts: { title?: string; subtitle?: string; closable?: boolean; autoFace?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.style.cssText = "position:fixed;inset:0;z-index:80;background:var(--bg);overflow:auto";
    const hasFace = !!store.passkeyId() && passkeySupported();
    layer.innerHTML = `
    <div class="pin-screen" style="max-width:480px;margin:0 auto">
      <div class="topbar">${opts.closable ? `<button class="icon-btn" data-act="close" aria-label="닫기">${ic.close()}</button>` : "<span></span>"}<span></span></div>
      <span style="margin-top:72px;width:48px;height:48px;border-radius:24px;background:var(--card);display:flex;align-items:center;justify-content:center">${ic.lock()}</span>
      <h1 class="title-sm" style="margin-top:20px;text-align:center;padding:0 8px">${esc(opts.title ?? "비밀번호를 입력해 주세요")}</h1>
      ${opts.subtitle ? `<p class="muted" style="margin-top:8px;font-size:14px;text-align:center">${esc(opts.subtitle)}</p>` : ""}
      ${dots(0)}
      <p class="pin-msg" role="alert"></p>
      ${hasFace ? `<button type="button" class="pill" data-act="face" style="margin-top:12px">${ic.face()}Face ID로 확인</button>` : ""}
      ${keypad()}
    </div>`;
    document.body.append(layer);
    const msg = layer.querySelector<HTMLElement>(".pin-msg")!;
    const finish = (ok: boolean) => {
      pad.destroy();
      layer.remove();
      resolve(ok);
    };
    const pad = bindPad(
      layer,
      (v) => layer.querySelectorAll(".pin-dots span").forEach((s, i) => s.classList.toggle("on", i < v.length)),
      async (v) => {
        const r = await checkPin(v);
        if (r.ok) return finish(true);
        shake(layer);
        msg.classList.add("err");
        msg.textContent = r.waitSec ? `여러 번 틀렸어요. ${r.waitSec}초 뒤에 다시 해 주세요` : `비밀번호가 달라요${r.left !== undefined ? ` (${r.left}번 남음)` : ""}`;
        pad.reset();
      },
    );
    layer.addEventListener("click", async (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "close") finish(false);
      if (act === "face") {
        if (await verifyPasskey()) finish(true);
        else {
          msg.classList.add("err");
          msg.textContent = "Face ID로 확인하지 못했어요. 비밀번호를 눌러 주세요";
        }
      }
    });
    if (hasFace && opts.autoFace) void verifyPasskey().then((ok) => ok && document.body.contains(layer) && finish(true));
  });
}

// ─── 앱 비밀번호 바꾸기 (PinChange): 지금 비밀번호 → 새 비밀번호 → 한 번 더. 닫으면 false ───
export function pinChange(): Promise<boolean> {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.style.cssText = "position:fixed;inset:0;z-index:80;background:var(--bg);overflow:auto";
    document.body.append(layer);
    let step: 1 | 2 | 3 = 1;
    let fresh = "";
    let msg = "";
    let err = false;
    const draw = () => {
      const title = step === 1 ? "지금 비밀번호를 눌러 주세요" : step === 2 ? "새 비밀번호 6자리를 눌러 주세요" : "한 번 더 눌러 주세요";
      const sub = step === 1 ? "확인되면 새 비밀번호를 정해요" : step === 2 ? "한 번 더 눌러 확인하면 바뀌어요" : "방금 누른 새 비밀번호를 확인해요";
      layer.innerHTML = `
      <div class="pin-screen" style="max-width:480px;margin:0 auto">
        <div class="topbar"><button class="icon-btn" data-act="close" aria-label="닫기">${ic.close()}</button><span class="t13 dim">${step} / 3</span></div>
        ${step > 1 ? `<span class="conn-chip" style="margin-top:56px"><span class="dot"></span>지금 비밀번호 확인됨</span>` : `<span style="margin-top:56px;width:48px;height:48px;border-radius:24px;background:var(--card);display:flex;align-items:center;justify-content:center">${ic.lock()}</span>`}
        <h1 class="title-sm" style="margin-top:20px;text-align:center">${title}</h1>
        <p class="muted" style="margin-top:8px;font-size:14px;text-align:center">${sub}</p>
        ${dots(0)}
        <p class="pin-msg ${err ? "err" : ""}" role="alert">${esc(msg)}</p>
        ${keypad()}
      </div>`;
    };
    const finish = (ok: boolean) => {
      pad.destroy();
      layer.remove();
      resolve(ok);
    };
    draw();
    const pad = bindPad(
      layer,
      (v) => layer.querySelectorAll(".pin-dots span").forEach((s, i) => s.classList.toggle("on", i < v.length)),
      async (v) => {
        if (step === 1) {
          const r = await checkPin(v);
          if (r.ok) {
            step = 2;
            msg = "";
            err = false;
          } else {
            err = true;
            msg = r.waitSec ? `여러 번 틀렸어요. ${r.waitSec}초 뒤에 다시 해 주세요` : `비밀번호가 달라요${r.left !== undefined ? ` (${r.left}번 남음)` : ""}`;
            shake(layer);
          }
        } else if (step === 2) {
          fresh = v;
          step = 3;
          msg = "";
          err = false;
        } else if (v === fresh) {
          await setPin(v);
          return finish(true);
        } else {
          step = 2;
          fresh = "";
          err = true;
          msg = "두 번 누른 숫자가 달라요 · 새 비밀번호부터 다시 눌러 주세요";
          shake(layer);
        }
        draw();
        pad.reset();
      },
    );
    layer.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest('[data-act="close"]')) finish(false);
    });
  });
}
