#!/usr/bin/env -S npx tsx
/**
 * 폰 짝짓기 QR을 터미널에 띄운다. 폰 카메라(또는 앱의 "QR 찍기")로 찍으면 그 폰이 주인으로 등록된다.
 *
 *   pnpm --filter @countersign/owner-app pair                     # 같은 와이파이: http://<이 맥 IP>:5173
 *   COUNTERSIGN_APP_URL=https://xxxx.trycloudflare.com pnpm --filter @countersign/owner-app pair   # 터널(HTTPS, Face ID 가능)
 *
 * QR 안에는 주인 토큰이 들어 있다 (비밀번호와 같다). 화면 공유·녹화 중에는 띄우지 않는다.
 * 토큰은 # 뒤에 있어서 앱 서버 로그에 남지 않고, 앱이 읽자마자 주소창에서 지운다.
 */
import { readFileSync } from "node:fs";
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
const link = `${appUrl}/#pair=${encodeURIComponent(token)}`;

console.log(await QRCode.toString(link, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
console.log(`Countersign 폰 연결: ${appUrl}`);
console.log("폰 카메라로 찍거나, 홈 화면 앱의 \"QR 찍기\"로 찍어 주세요.");
if (process.argv.includes("--print-link")) console.log(link);
else console.log("(연결 코드가 필요하면 --print-link. 토큰이 그대로 보이니 주의)");
