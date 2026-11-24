import { createHspClient, loadHspConfig } from "@countersign/hsp";
import { SignerClient } from "@countersign/signer/client";
import {
  ApprovalStore,
  FileSpendLedger,
  HistoryStore,
  PolicyFile,
  TaskStore,
  parseTicketSecret,
  readOrCreateSharedSecret,
  readPause,
  statePaths,
} from "@countersign/wallet-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rpcBalanceReader } from "./balances.js";
import { WalletService } from "./service.js";
import { registerWalletTools } from "./tools.js";

/**
 * 환경변수로 지갑 서비스를 만든다 (stdio·HTTP 공통). 키는 읽지 않는다.
 * COUNTERSIGN_POLICY(필수, signer와 같은 파일), COUNTERSIGN_HSP_MODE / COUNTERSIGN_HSP_MCP_URL / COUNTERSIGN_PAY_CHAIN_ID,
 * COUNTERSIGN_HOME(상태 폴더), COUNTERSIGN_POLL_MS
 */
export async function walletFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const policyPath = env.COUNTERSIGN_POLICY;
  if (!policyPath) throw new Error("COUNTERSIGN_POLICY(정책 파일 경로)가 필요함");
  const policyFile = new PolicyFile(policyPath);
  const policy = policyFile.get();
  const paths = statePaths(env);
  const secretHex = env.COUNTERSIGN_TICKET_SECRET || readOrCreateSharedSecret(paths.ticketSecret, false);
  if (!secretHex) throw new Error("검증 티켓 키가 없음: signer를 먼저 실행하세요");
  const hspConfig = loadHspConfig(env);
  const wallet = new WalletService({
    hsp: await createHspClient(hspConfig),
    signer: new SignerClient(paths.signerSocket),
    policy: () => policyFile.get(),
    ticketSecret: parseTicketSecret(secretHex),
    ledger: new FileSpendLedger(paths.walletLedger),
    history: new HistoryStore(paths.history),
    pause: () => readPause(paths.pause),
    approvals: new ApprovalStore(paths.approvals),
    tasks: new TaskStore(paths.tasks),
    balances: rpcBalanceReader(env),
    hspMode: hspConfig.mode,
    pollIntervalMs: Number(env.COUNTERSIGN_POLL_MS || 2000),
  });
  return { wallet, policy, paths, hspConfig };
}

export function buildMcpServer(wallet: WalletService, caller: string): McpServer {
  const server = new McpServer(
    { name: "countersign-wallet", version: "0.0.0" },
    {
      instructions:
        "Countersign agent wallet. Use get_policy to see which sellers you may pay, then pay_order with the seller's order_ref. " +
        "The wallet verifies every order against HSP and the owner's policy before signing; if it rejects, read code and next_action. " +
        "Use next_task to pick up errands the owner delegated from their phone.",
    },
  );
  registerWalletTools(server, wallet, caller);
  return server;
}
