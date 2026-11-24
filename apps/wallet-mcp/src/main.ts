#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { createHspClient, loadHspConfig } from "@countersign/hsp";
import { SignerClient } from "@countersign/signer/client";
import {
  FileSpendLedger,
  HistoryStore,
  parsePolicy,
  parseTicketSecret,
  readOrCreateSharedSecret,
  readPause,
  statePaths,
} from "@countersign/wallet-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { rpcBalanceReader } from "./balances.js";
import { WalletService } from "./service.js";
import { registerWalletTools } from "./tools.js";

/**
 * 지갑 MCP 서버 (stdio). Claude Code·Codex CLI 같은 에이전트가 자식 프로세스로 띄운다.
 * 키를 읽지 않는다 (AGENTS.md 규칙 6). 서명은 signer 소켓에 부탁한다. signer를 먼저 켜 둬야 한다.
 * stdout은 MCP 통신용이라 로그는 stderr로만 쓴다.
 *
 * 환경변수: COUNTERSIGN_POLICY(필수, signer와 같은 파일), COUNTERSIGN_HSP_MODE / COUNTERSIGN_HSP_MCP_URL /
 *          COUNTERSIGN_PAY_CHAIN_ID, COUNTERSIGN_HOME(상태 폴더), COUNTERSIGN_POLL_MS
 */
async function main() {
  const policyPath = process.env.COUNTERSIGN_POLICY;
  if (!policyPath) throw new Error("COUNTERSIGN_POLICY(정책 파일 경로)가 필요함");
  const policy = parsePolicy(JSON.parse(readFileSync(policyPath, "utf8")));
  const paths = statePaths();
  const secretHex = process.env.COUNTERSIGN_TICKET_SECRET || readOrCreateSharedSecret(paths.ticketSecret, false);
  if (!secretHex) throw new Error("검증 티켓 키가 없음: signer를 먼저 실행하세요");
  const hspConfig = loadHspConfig();

  const wallet = new WalletService({
    hsp: await createHspClient(hspConfig),
    signer: new SignerClient(paths.signerSocket),
    policy,
    ticketSecret: parseTicketSecret(secretHex),
    ledger: new FileSpendLedger(paths.walletLedger),
    history: new HistoryStore(paths.history),
    pause: () => readPause(paths.pause),
    balances: rpcBalanceReader(),
    hspMode: hspConfig.mode,
    pollIntervalMs: Number(process.env.COUNTERSIGN_POLL_MS || 2000),
  });

  const server = new McpServer(
    { name: "countersign-wallet", version: "0.0.0" },
    {
      instructions:
        "Countersign agent wallet. Use get_policy to see which sellers you may pay, then pay_order with the seller's order_ref. " +
        "The wallet verifies every order against HSP and the owner's policy before signing; if it rejects, read code and next_action.",
    },
  );
  registerWalletTools(server, wallet);
  await server.connect(new StdioServerTransport());
  console.error(`countersign-wallet-mcp: ${policy.agent}, HSP ${hspConfig.mode}, 체인 ${[...policy.chains].join(",")}`);
}

main().catch((e: unknown) => {
  console.error(`countersign-wallet-mcp 시작 실패: ${e instanceof Error ? e.message : "알 수 없는 오류"}`);
  process.exit(1);
});
