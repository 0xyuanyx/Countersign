#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { SignerClient } from "@countersign/signer/client";
import { parsePolicy, readOrCreateSharedSecret, statePaths } from "@countersign/wallet-core";
import { rpcBalanceReader } from "@countersign/wallet-mcp";
import { formatAmount } from "@countersign/wallet-core";
import { createOwnerApi, listenOwnerApi } from "./server.js";

/**
 * 주인 API 실행: COUNTERSIGN_POLICY=정책.json pnpm --filter @countersign/owner-api start  (기본 127.0.0.1:7420)
 * 주인 토큰은 COUNTERSIGN_OWNER_TOKEN 또는 ~/.countersign/owner.token (없으면 만든다). 값은 출력하지 않는다.
 * PWA 개발 서버 주소는 COUNTERSIGN_APP_ORIGIN (쉼표로 여러 개, 기본 http://localhost:5173).
 */
const policyPath = process.env.COUNTERSIGN_POLICY;
if (!policyPath) {
  console.error("COUNTERSIGN_POLICY(정책 파일 경로)가 필요함");
  process.exit(1);
}
const policy = parsePolicy(JSON.parse(readFileSync(policyPath, "utf8")));
const paths = statePaths();
const ownerToken = process.env.COUNTERSIGN_OWNER_TOKEN || readOrCreateSharedSecret(paths.ownerToken, true)!;
const signer = new SignerClient(paths.signerSocket, 3000);
const reader = rpcBalanceReader();
const accountOf = async () => {
  const r = await signer.address().catch(() => undefined);
  return r?.ok && r.op === "address" ? r.address : undefined;
};
const server = createOwnerApi({
  policy,
  paths,
  ownerToken,
  account: accountOf,
  balances: async () => {
    const account = await accountOf();
    if (!account) return { balances: [...policy.tokens.keys()].map((c) => ({ chain_id: c, error: "signer가 꺼져 있어 주소를 모름" })) };
    const balances = await Promise.all(
      [...policy.tokens].map(async ([chainId, token]) => {
        try {
          return { chain_id: chainId, balance: formatAmount(await reader.usdcBalance(chainId, token, account)) };
        } catch {
          return { chain_id: chainId, error: "RPC 조회 실패" };
        }
      }),
    );
    return { account, balances };
  },
  allowedOrigins: (process.env.COUNTERSIGN_APP_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim()),
});
const url = await listenOwnerApi(server, Number(process.env.COUNTERSIGN_OWNER_API_PORT || 7420));
console.log(`countersign-owner-api: ${url} (재개 토큰 파일: ${process.env.COUNTERSIGN_OWNER_TOKEN ? "환경변수" : paths.ownerToken})`);
