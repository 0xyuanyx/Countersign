#!/usr/bin/env -S npx tsx
import { KNOWN_USDC, createHspClient, loadHspConfig } from "@countersign/hsp";
import { getAddress } from "viem";
import { catalogFor } from "./catalog.js";
import { EVIL_MODES, createSeller, listenSeller, type EvilMode } from "./server.js";

/**
 * 판매 서버 실행 (키 없음):
 *   COUNTERSIGN_SELLER_PAY_TO=0x... COUNTERSIGN_HSP_MCP_URL=http://127.0.0.1:7410/mcp pnpm --filter @countersign/seller start
 * 악성 판매자: COUNTERSIGN_SELLER_EVIL=payee|amount|chain|inject
 * 그 밖: COUNTERSIGN_SELLER_NAME (기본 data-mart), COUNTERSIGN_SELLER_PORT (기본 7430), COUNTERSIGN_PAY_CHAIN_ID (기본 11155111 Ethereum Sepolia, HSK 테스트넷은 133)
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
const hsp = await createHspClient(hspConfig);
// 네트워크·토큰은 HSP get_chain_config에서만 (가이드 §5, AGENTS.md 규칙 9). 그 체인의 USDC(eip3009)가 없으면 시작하지 않는다
const cfg = await hsp.getChainConfig();
const chain = cfg.chains.find((c) => c.chain_id === hspConfig.payChainId);
const tokenRaw = chain?.tokens.USDC ?? chain?.tokens.usdc;
if (!tokenRaw) {
  console.error(`HSP get_chain_config에 체인 ${hspConfig.payChainId}의 USDC가 없음`);
  process.exit(1);
}
const token = getAddress(tokenRaw);
if (KNOWN_USDC[hspConfig.payChainId] && token.toLowerCase() !== KNOWN_USDC[hspConfig.payChainId]!.toLowerCase()) {
  console.error(`경고: HSP의 USDC(${token})가 알려진 주소와 다름 — 구매자 정책의 토큰 주소도 HSP 값으로 맞춰야 결제된다`);
}
let url = "";
const server = createSeller({
  hsp,
  name: env.COUNTERSIGN_SELLER_NAME || "data-mart",
  payTo: getAddress(payToRaw),
  chainId: hspConfig.payChainId,
  token,
  // 상품 목록: COUNTERSIGN_SELLER_CATALOG = data-mart(기본) | news-wire | lookalike(악성 판매자용)
  catalog: catalogFor(env.COUNTERSIGN_SELLER_CATALOG || (evil ? "lookalike" : env.COUNTERSIGN_SELLER_NAME)),
  ...(evil && { evil }),
  publicUrl: () => url,
});
url = await listenSeller(server, Number(env.COUNTERSIGN_SELLER_PORT || 7430));
console.log(`countersign-seller: ${url}${evil ? ` (악성 모드: ${evil})` : ""}`);
