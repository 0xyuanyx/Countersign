#!/usr/bin/env -S npx tsx
import { rotateSharedSecret, statePaths } from "@countersign/wallet-core";

/**
 * 주인 토큰 바꾸기 (폰을 잃어버렸을 때 등): node_modules/.bin/tsx apps/owner-api/src/rotate-token.ts
 * ~/.countersign/owner.token(COUNTERSIGN_HOME)을 새 값으로 바꾼다. 주인 API와 signer는 요청마다 파일을 다시 읽어서
 * 재시작 없이 바로 이전 토큰을 거절한다. 그다음 폰에서 다시 짝짓기만 하면 된다 (pnpm --filter @countersign/owner-app pair).
 * 새 토큰 값은 화면에 출력하지 않는다.
 */
if (process.env.COUNTERSIGN_OWNER_TOKEN) {
  console.error("COUNTERSIGN_OWNER_TOKEN 환경변수로 토큰을 쓰는 중: 그 값을 직접 바꿔야 함");
  process.exit(1);
}
const path = statePaths().ownerToken;
rotateSharedSecret(path);
console.log(`주인 토큰을 바꿨어요 (${path}). 이전 토큰을 가진 폰은 이제 거절돼요. 폰에서 다시 짝짓기하세요.`);
