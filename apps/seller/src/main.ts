#!/usr/bin/env -S npx tsx
import { KNOWN_USDC, createHspClient, loadHspConfig } from "@countersign/hsp";
import { getAddress } from "viem";
import { EVIL_MODES, createSeller, listenSeller, type EvilMode } from "./server.js";

/**
 * 판매 서버 실행 (키 없음):
 *   COUNTERSIGN_SELLER_PAY_TO=0x... COUNTERSIGN_HSP_MCP_URL=http://127.0.0.1:7410/mcp pnpm --filter @countersign/seller start
 * 악성 판매자: COUNTERSIGN_SELLER_EVIL=payee|amount|chain|inject
 * 그 밖: COUNTERSIGN_SELLER_NAME (기본 profile-seller), COUNTERSIGN_SELLER_PORT (기본 7430), COUNTERSIGN_PAY_CHAIN_ID (기본 11155111 Ethereum Sepolia, HSK 테스트넷은 133)
 */
const env = process.env;
const payToRaw = env.COUNTERSIGN_SELLER_PAY_TO;
if (!payToRaw) {
  console.error("COUNTERSIGN_SELLER_PAY_TO(판매 대금 받을 주소)가 필요함");
  process.exit(1);
}
const evil = env.COUNTERSIGN_SELLER_EVIL as EvilMode | undefined;
if (evil && !EVIL_MODES.includes(evil)) {
  console.error(`COUNTERSIGN_SELLER_EVIL은 ${EVIL_MODES.join("|")} 중 하나`);
  process.exit(1);
}
const hspConfig = loadHspConfig();
if (hspConfig.mode === "mock" && !hspConfig.mcpUrl) {
  console.error("판매 서버와 구매자 지갑이 같은 HSP mock을 써야 함: COUNTERSIGN_HSP_MCP_URL=http://127.0.0.1:7410/mcp");
  process.exit(1);
}
const token = KNOWN_USDC[hspConfig.payChainId];
if (!token) {
  console.error(`체인 ${hspConfig.payChainId}의 USDC 주소를 모름`);
  process.exit(1);
}
let url = "";
const server = createSeller({
  hsp: await createHspClient(hspConfig),
  name: env.COUNTERSIGN_SELLER_NAME || "profile-seller",
  payTo: getAddress(payToRaw),
  chainId: hspConfig.payChainId,
  token,
  catalog: [{ sku: "profile", name: "Wallet address profile report", price: "0.10" }],
  ...(evil && { evil }),
  publicUrl: () => url,
});
url = await listenSeller(server, Number(env.COUNTERSIGN_SELLER_PORT || 7430));
console.log(`countersign-seller: ${url}${evil ? ` (악성 모드: ${evil})` : ""}`);
