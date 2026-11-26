#!/usr/bin/env -S npx tsx
/**
 * 폰 매칭 QR을 터미널에 띄운다. 폰 카메라(또는 앱의 "QR 찍기")로 찍으면 그 폰이 주인으로 등록된다.
 *
 *   pnpm --filter @countersign/owner-app pair                     # 같은 와이파이: http://<이 맥 IP>:5173 (Vite가 /api를 넘겨 줌)
 *   COUNTERSIGN_APP_URL=https://<앱>.vercel.app COUNTERSIGN_OWNER_API_URL=https://<맥 터널 주소> pnpm --filter @countersign/owner-app pair
 *     → Vercel 앱 + 맥 주인 API(HTTPS 터널). Face ID 가능. 터널 주소가 고정이면 한 번만 매칭하면 된다 (apps/demo/tunnel.sh)
 *
 * 맥에서는 큰 QR 그림도 미리보기로 띄운다 (3분 뒤 지움, --no-image로 끔). 앱의 "QR 찍기"로 그 그림을 찍으면 잘 읽힌다.
 * QR 안에는 주인 토큰이 들어 있다 (비밀번호와 같다). 화면 공유·녹화 중에는 띄우지 않는다.
 * 토큰은 # 뒤에 있어서 앱 서버 로그에 남지 않고, 앱이 읽자마자 주소창에서 지운다.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import { statePaths } from "@countersign/wallet-core";

function lanIp(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

const token = process.env.COUNTERSIGN_OWNER_TOKEN || readFileSync(statePaths().ownerToken, "utf8").trim();
if (!token) {
  console.error("주인 토큰이 없음: 주인 API를 한 번 실행하면 ~/.countersign/owner.token이 생긴다");
  process.exit(1);
}
const appUrl = (process.env.COUNTERSIGN_APP_URL || `http://${lanIp() ?? "localhost"}:5173`).replace(/\/+$/, "");
const apiUrl = (process.env.COUNTERSIGN_OWNER_API_URL || "").replace(/\/+$/, "");
if (apiUrl && !/^https:\/\//.test(apiUrl)) {
  console.error("COUNTERSIGN_OWNER_API_URL은 https:// 주소여야 함 (Vercel 앱은 HTTPS라 http 주인 API를 못 부른다)");
  process.exit(1);
}
if (!apiUrl && /\.vercel\.app$/.test(new URL(appUrl).host)) {
  // QR을 짧게: 터널 주소를 Vercel 환경변수 VITE_OWNER_API_URL로 앱에 넣어 두면 QR에는 토큰만 들어간다
  console.log("QR에는 토큰만 넣어요 · 앱에 든 기본 터널 주소(src/auth.ts DEFAULT_OWNER_API)로 연결돼요");
  console.log("(다른 터널 주소면 COUNTERSIGN_OWNER_API_URL=https://<맥 터널 주소>로 다시 실행)\n");
}
const link = `${appUrl}/#pair=${encodeURIComponent(token)}${apiUrl ? `&api=${encodeURIComponent(apiUrl)}` : ""}`;

// 오류 정정 L: 칸 수가 가장 적어서 폰 카메라가 읽기 쉽다 (화면에서 찍으니 손상 걱정이 적음)
console.log(await QRCode.toString(link, { type: "terminal", small: true, errorCorrectionLevel: "L" }));

// 맥이면 큰 QR 그림도 띄운다 (터미널 글꼴 QR은 줄 간격 때문에 잘 안 읽힐 때가 있음). --no-image로 끈다.
// 그림에도 주인 토큰이 들어 있으므로 상태 폴더에 0600으로 만들고 3분 뒤 지운다.
if (process.platform === "darwin" && !process.argv.includes("--no-image")) {
  const img = join(dirname(statePaths().ownerToken), "pair-qr.png");
  await QRCode.toFile(img, link, { errorCorrectionLevel: "L", width: 900, margin: 4 });
  chmodSync(img, 0o600);
  execFileSync("open", [img]);
  console.log(`큰 QR 그림을 열었어요 (3분 뒤 지움): ${img}`);
  setTimeout(() => rmSync(img, { force: true }), 180_000);
  process.on("SIGINT", () => {
    rmSync(img, { force: true });
    process.exit(0);
  });
}
console.log(`Countersign 폰 연결: ${appUrl}${apiUrl ? `  (지갑 서버 ${apiUrl})` : ""}`);
console.log("폰 카메라로 찍거나, 홈 화면 앱의 \"QR 찍기\"로 찍어 주세요.");
if (process.argv.includes("--print-link")) console.log(link);
else console.log("(연결 코드가 필요하면 --print-link. 토큰이 그대로 보이니 주의)");
