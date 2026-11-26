// 매칭 QR 읽기. 아이폰 Safari에는 BarcodeDetector가 없어서 JS 디코더로 읽는다.
// 1순위 zxing-cpp(WASM, 앱과 같은 주소에서 받음: 화면 무아레·반전·기울기에 강함), 못 불러오면 jsQR.
// 카메라는 높은 해상도로 열고, 네모 칸 부분만 잘라 두 가지 크기로 번갈아 읽는다.

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

type Decoder = { name: string; read: (img: ImageData) => Promise<string | undefined> };
let decoderP: Promise<Decoder> | undefined;

export function decoder(): Promise<Decoder> {
  decoderP ??= (async () => {
    try {
      const z = await import("zxing-wasm/reader");
      await z.prepareZXingModule({ overrides: { locateFile: (p: string, prefix: string) => (p.endsWith(".wasm") ? wasmUrl : prefix + p) }, fireImmediately: true });
      const opts = { formats: ["QRCode"] as const, tryHarder: true, tryInvert: true, tryRotate: true, tryDownscale: true, maxNumberOfSymbols: 1 };
      return {
        name: "zxing",
        read: async (img: ImageData) => (await z.readBarcodes(img, { ...opts, formats: [...opts.formats] }))[0]?.text || undefined,
      };
    } catch {
      const jsQR = (await import("jsqr")).default;
      return { name: "jsQR", read: async (img: ImageData) => jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data };
    }
  })();
  return decoderP;
}

export type ScanInfo = { camera: string; decoder: string; frames: number; seconds: number; lastText?: string };

/**
 * 카메라를 열고 QR을 찾는다. onText가 true를 돌려주면 멈춘다.
 * onInfo는 몇 번에 한 번 진단 정보(해상도·디코더·읽은 프레임 수)를 준다.
 */
export async function startCamera(
  video: HTMLVideoElement,
  onText: (text: string) => boolean,
  onInfo: (i: ScanInfo) => void,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  let alive = true;
  const stop = () => {
    alive = false;
    stream.getTracks().forEach((t) => t.stop());
  };
  video.srcObject = stream;
  await video.play().catch(() => {});

  // 초점은 계속 맞추기, 줌이 되면 살짝(1.6배): 아이폰 광각은 가까이 대면 초점이 안 맞아서, 조금 떨어져 찍게 한다
  const track = stream.getVideoTracks()[0];
  try {
    const caps = (track?.getCapabilities?.() ?? {}) as { focusMode?: string[]; zoom?: { min: number; max: number } };
    const adv: Record<string, unknown>[] = [];
    if (caps.focusMode?.includes("continuous")) adv.push({ focusMode: "continuous" });
    if (caps.zoom && caps.zoom.max >= 1.6) adv.push({ zoom: Math.max(caps.zoom.min, 1.6) });
    if (adv.length) await track!.applyConstraints({ advanced: adv } as MediaTrackConstraints);
  } catch {
    /* 지원 안 하면 그대로 */
  }

  const dec = await decoder();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const started = Date.now();
  let frames = 0;
  let lastText: string | undefined;

  const tick = async () => {
    if (!alive) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh) {
      // 화면의 네모 칸 = 영상 가운데 정사각형. 번갈아: 네모 전체(최대 1200으로), 네모 가운데 60%(원본 크기, 멀리 찍었을 때)
      const side = Math.min(vw, vh);
      const near = frames % 2 === 1;
      const crop = near ? Math.round(side * 0.6) : side;
      const out = Math.min(crop, near ? 1000 : 1200);
      canvas.width = out;
      canvas.height = out;
      ctx.drawImage(video, (vw - crop) / 2, (vh - crop) / 2, crop, crop, 0, 0, out, out);
      frames++;
      let text: string | undefined;
      try {
        text = await dec.read(ctx.getImageData(0, 0, out, out));
      } catch {
        text = undefined;
      }
      if (text) {
        lastText = text;
        if (onText(text)) return stop();
      }
      if (frames % 5 === 0) onInfo({ camera: `${vw}×${vh}`, decoder: dec.name, frames, seconds: Math.round((Date.now() - started) / 1000), lastText });
    }
    setTimeout(tick, 60);
  };
  void tick();
  return stop;
}

/** 사진 한 장에서 QR 읽기 (아이폰 기본 카메라로 찍으면 초점·해상도가 훨씬 좋다) */
export async function readPhoto(file: File): Promise<string | undefined> {
  const dec = await decoder();
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  // 전체(최대 2000)와 가운데 절반(원본) 두 번
  for (const [frac, max] of [
    [1, 2000],
    [0.5, 2000],
  ] as const) {
    const cw = bmp.width * frac;
    const ch = bmp.height * frac;
    const scale = Math.min(1, max / Math.max(cw, ch));
    canvas.width = Math.round(cw * scale);
    canvas.height = Math.round(ch * scale);
    ctx.drawImage(bmp, (bmp.width - cw) / 2, (bmp.height - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
    const t = await dec.read(ctx.getImageData(0, 0, canvas.width, canvas.height)).catch(() => undefined);
    if (t) return t;
  }
  return undefined;
}
