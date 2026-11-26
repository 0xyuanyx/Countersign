// 이 폰에 저장하는 것: 지갑 서버 주소, 주인 토큰, 앱 비밀번호(해시), 패스키 id.
// 앱 비밀번호와 Face ID는 "이 폰에서 앱을 여는 사람이 주인인지" 확인하는 잠금일 뿐이다.
// 서버가 믿는 건 주인 토큰 하나다 (README의 주장표에서 NOT-CLAIMED로 둔다).

const K = { pair: "cs.pair", pin: "cs.pin", passkey: "cs.passkey", seen: "cs.seen" } as const;

export type Pairing = { base: string; token: string; label: string; mock?: boolean };

function read<T>(key: string): T | undefined {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}
function write(key: string, v: unknown): void {
  try {
    if (v === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 사생활 보호 모드 등: 이번 실행 동안만 메모리로 */
  }
}

export const store = {
  pairing: () => read<Pairing>(K.pair),
  setPairing: (p: Pairing | undefined) => write(K.pair, p),
  hasPin: () => read(K.pin) !== undefined,
  passkeyId: () => read<string>(K.passkey),
  setPasskeyId: (id: string | undefined) => write(K.passkey, id),
  seen: () => read<string[]>(K.seen) ?? [],
  markSeen: (id: string) => write(K.seen, [id, ...(read<string[]>(K.seen) ?? []).filter((x) => x !== id)].slice(0, 50)),
  /** 다시 매칭: 이 폰의 모든 값을 지운다 */
  reset: () => Object.values(K).forEach((k) => write(k, undefined)),
};

/**
 * 기본 주인 API 주소 (공개 값, 비밀 아님). 배포본(Vercel)은 맥의 고정 터널 주소를 기본으로 써서
 * 매칭 QR에 토큰만 넣는다 → QR이 짧아져 폰 카메라가 잘 읽는다. VITE_OWNER_API_URL로 바꿀 수 있다.
 * 터널 주소를 바꾸면 여기와 apps/demo/tunnel.sh를 같이 바꾼다.
 */
const DEFAULT_OWNER_API: string = import.meta.env.VITE_OWNER_API_URL ?? (import.meta.env.PROD ? "https://gone-headscarf-unsoiled.ngrok-free.dev" : "");

// ─── 매칭 링크 ───
// 지갑 서버(pnpm --filter @countersign/owner-app pair)가 띄우는 QR = https://<앱 주소>/#pair=<주인 토큰>[&api=<주인 API 주소>]
// Vercel에 올린 앱은 주인 API와 주소가 달라서 api=(맥의 HTTPS 터널 주소)가 꼭 있어야 한다.
// 토큰은 # 뒤에 있어서 앱 서버로 전송되지 않는다. 읽은 뒤 주소창에서 바로 지운다.

export function parsePairing(input: string): Pairing | undefined {
  const s = input.trim();
  if (!s) return undefined;
  let frag = s;
  let label = location.host;
  const hashAt = s.indexOf("#");
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      label = u.host;
      frag = u.hash.slice(1);
    } catch {
      return undefined;
    }
  } else if (hashAt >= 0) frag = s.slice(hashAt + 1);
  const params = new URLSearchParams(frag);
  const token = params.get("pair") ?? (/^[A-Za-z0-9_\-.~+/=]{16,200}$/.test(s) ? s : null);
  if (!token) return undefined;
  // api=가 없으면 기본 주인 API 주소, 그것도 없으면 같은 주소의 /api (Vite 개발 서버 프록시)
  const api = params.get("api") || DEFAULT_OWNER_API;
  if (api && !/^https?:\/\//i.test(api)) return undefined;
  return { base: api.replace(/\/+$/, ""), token, label: api ? new URL(api).host : label };
}

// ─── 앱 비밀번호 6자리 ───
type PinRecord = { salt: string; hash: string; iter: number; fails?: number; lockedUntil?: number };
const ITER = 210_000;

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b: ArrayBuffer) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

async function derive(pin: string, salt: Uint8Array, iter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter }, key, 256);
  return b64(bits);
}

export async function setPin(pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  write(K.pin, { salt: b64(salt), hash: await derive(pin, salt, ITER), iter: ITER } satisfies PinRecord);
}

export type PinCheck = { ok: true } | { ok: false; waitSec?: number; left?: number };

/** 5번 틀리면 30초, 그 뒤로 틀릴 때마다 대기 시간이 두 배 */
export async function checkPin(pin: string): Promise<PinCheck> {
  const r = read<PinRecord>(K.pin);
  if (!r) return { ok: false };
  const now = Date.now();
  if (r.lockedUntil && r.lockedUntil > now) return { ok: false, waitSec: Math.ceil((r.lockedUntil - now) / 1000) };
  const hash = await derive(pin, unb64(r.salt), r.iter);
  if (hash === r.hash) {
    write(K.pin, { ...r, fails: 0, lockedUntil: undefined });
    return { ok: true };
  }
  const fails = (r.fails ?? 0) + 1;
  const lockedUntil = fails >= 5 ? now + 30_000 * 2 ** (fails - 5) : undefined;
  write(K.pin, { ...r, fails, lockedUntil });
  return lockedUntil ? { ok: false, waitSec: Math.ceil((lockedUntil - now) / 1000) } : { ok: false, left: 5 - fails };
}

// ─── Face ID / 지문 (웹 패스키) ───
// HTTPS(또는 localhost)에서만 된다. 같은 와이파이의 http://192.168… 주소로 열면 버튼을 숨긴다.

export function passkeySupported(): boolean {
  return window.isSecureContext && typeof PublicKeyCredential !== "undefined" && !!navigator.credentials;
}

export async function createPasskey(): Promise<boolean> {
  if (!passkeySupported()) return false;
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "Countersign" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "owner", displayName: "Countersign 주인" },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
        timeout: 60_000,
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
    if (!cred) return false;
    store.setPasskeyId(b64url(cred.rawId));
    return true;
  } catch {
    return false;
  }
}

export async function verifyPasskey(): Promise<boolean> {
  const id = store.passkeyId();
  if (!id || !passkeySupported()) return false;
  try {
    const got = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: unb64url(id) as BufferSource }],
        userVerification: "required",
        timeout: 60_000,
      },
    });
    return !!got;
  } catch {
    return false;
  }
}

// ─── 실행 환경 ───
export function isStandalone(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
export function isMobile(): boolean {
  return isIOS() || /Android/.test(navigator.userAgent);
}
