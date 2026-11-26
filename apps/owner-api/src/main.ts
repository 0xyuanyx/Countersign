#!/usr/bin/env -S npx tsx
import { SignerClient } from "@countersign/signer/client";
import { PolicyFile, readOrCreateSharedSecret, statePaths } from "@countersign/wallet-core";
import { rpcBalanceReader } from "@countersign/wallet-mcp";
import { formatAmount } from "@countersign/wallet-core";
import { DEMO_SELLERS } from "./catalog.js";
import { createOwnerApi, listenOwnerApi } from "./server.js";

/**
 * 주인 API 실행: COUNTERSIGN_POLICY=정책.json pnpm --filter @countersign/owner-api start  (기본 127.0.0.1:7420)
 * 주인 토큰은 COUNTERSIGN_OWNER_TOKEN 또는 ~/.countersign/owner.token (없으면 만든다). 값은 출력하지 않는다.
 * PWA 주소는 COUNTERSIGN_APP_ORIGIN (쉼표로 여러 개, 기본 http://localhost:5173). Vercel에 올린 앱이면 그 주소 하나만.
 * 터널로 인터넷에 열 때는 COUNTERSIGN_OWNER_API_PUBLIC=1: 읽기·긴급 정지까지 모든 요청에 주인 토큰을 요구한다.
 */
const policyPath = process.env.COUNTERSIGN_POLICY;
if (!policyPath) {
  console.error("COUNTERSIGN_POLICY(정책 파일 경로)가 필요함");
  process.exit(1);
}
const policyFile = new PolicyFile(policyPath);
policyFile.get(); // 시작할 때 한 번 검증
const paths = statePaths();
// 주인 토큰: 처음 한 번 만들고(있으면 그대로), 요청마다 파일을 다시 읽는다 → rotate-owner-token으로 바꾸면 바로 반영
if (!process.env.COUNTERSIGN_OWNER_TOKEN) readOrCreateSharedSecret(paths.ownerToken, true);
const ownerToken = () => process.env.COUNTERSIGN_OWNER_TOKEN || readOrCreateSharedSecret(paths.ownerToken, false) || "";
const signer = new SignerClient(paths.signerSocket, 3000);
const reader = rpcBalanceReader();
const accountOf = async () => {
  const r = await signer.address().catch(() => undefined);
  return r?.ok && r.op === "address" ? r.address : undefined;
};
const server = createOwnerApi({
  policy: policyFile,
  paths,
  ownerToken,
  account: accountOf,
  agentOps: {
    address: async (agentId) => {
      const r = await signer.forAgent(agentId).address();
      return r.ok && r.op === "address" ? r.address : undefined;
    },
    usdcBalance: (chainId, token, owner) => reader.usdcBalance(chainId, token, owner),
    nativeBalance: (chainId, owner) => reader.nativeBalance(chainId, owner),
    withdraw: async (agentId, amount, requestId) => {
      const r = await signer.forAgent(agentId).withdrawToOwner(ownerToken(), amount, requestId);
      if (r.ok && r.op === "withdraw_to_owner") return r;
      if (!r.ok) return { ok: false, code: r.code, reason: r.reason, next_action: r.next_action };
      return { ok: false, code: "WITHDRAW_FAILED", reason: "signer 응답이 예상과 다름" };
    },
  },
  // 앱 요청 (11/26): 새 에이전트(2번 계정부터) 기본 정책 — 1회 0.5, 하루 5, 판매자 없음, Ethereum Sepolia
  // 맡기기 추천 칩: demo.sh 판매자들 (COUNTERSIGN_CATALOG_SELLERS='[{"url":"...","scenario":"normal"}]'로 바꿈)
  catalogSellers: process.env.COUNTERSIGN_CATALOG_SELLERS ? JSON.parse(process.env.COUNTERSIGN_CATALOG_SELLERS) : DEMO_SELLERS,
  newAgentPolicy: { perTxMax: "0.5", dailyMax: "5", chains: [11155111], sellers: {} },
  ...(process.env.COUNTERSIGN_PUBLIC_MCP_URL && { publicMcpUrl: process.env.COUNTERSIGN_PUBLIC_MCP_URL }),
  balances: async () => {
    const account = await accountOf();
    if (!account) return { balances: [...policyFile.get().tokens.keys()].map((c) => ({ chain_id: c, error: "signer가 꺼져 있어 주소를 모름" })) };
    const balances = await Promise.all(
      [...policyFile.get().tokens].map(async ([chainId, token]) => {
        try {
          return { chain_id: chainId, balance: formatAmount(await reader.usdcBalance(chainId, token, account)) };
        } catch {
          return { chain_id: chainId, error: "RPC 조회 실패" };
        }
      }),
    );
    return { account, balances };
  },
  allowedOrigins: (process.env.COUNTERSIGN_APP_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  requireTokenAll: process.env.COUNTERSIGN_OWNER_API_PUBLIC === "1",
});
const url = await listenOwnerApi(server, Number(process.env.COUNTERSIGN_OWNER_API_PORT || 7420));
console.log(`countersign-owner-api: ${url}${process.env.COUNTERSIGN_OWNER_API_PUBLIC === "1" ? " (공개 모드: 모든 요청에 주인 토큰)" : ""} (재개 토큰 파일: ${process.env.COUNTERSIGN_OWNER_TOKEN ? "환경변수" : paths.ownerToken})`);
