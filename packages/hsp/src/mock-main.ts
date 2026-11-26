#!/usr/bin/env -S npx tsx
import { KNOWN_USDC, KNOWN_USDC_NAME } from "./config.js";
import { serveMockHsp } from "./mock-server.js";

/**
 * HSP mock 서버 실행: pnpm --filter @countersign/hsp mock   (기본 127.0.0.1:7410, Ethereum Sepolia 11155111)
 * COUNTERSIGN_HSP_MOCK_PORT, COUNTERSIGN_PAY_CHAIN_ID로 바꾼다.
 */
const chainId = Number(process.env.COUNTERSIGN_PAY_CHAIN_ID || 11155111);
const token = KNOWN_USDC[chainId];
if (!token) {
  console.error(`hsp-mock: 체인 ${chainId}의 USDC 주소를 모름`);
  process.exit(1);
}
const port = Number(process.env.COUNTERSIGN_HSP_MOCK_PORT || 7410);
const s = await serveMockHsp({ chainId, token, port, tokenName: KNOWN_USDC_NAME[chainId] ?? "USD Coin" });
console.log(`hsp-mock: ${s.url} (체인 ${chainId}, 돈은 움직이지 않음)`);
const stop = () => void s.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
