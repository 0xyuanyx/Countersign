import { createHspClient, loadHspConfig } from "@countersign/hsp";
import { SignerClient } from "@countersign/signer/client";
import {
  AgentRegistry,
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
import { WalletService, type Caller, type WalletDeps } from "./service.js";
import { registerWalletTools } from "./tools.js";

/**
 * 환경변수로 지갑 서비스를 만든다 (stdio·HTTP 공통). 키는 읽지 않는다.
 * COUNTERSIGN_POLICY(필수, signer와 같은 파일), COUNTERSIGN_HSP_MODE / COUNTERSIGN_HSP_MCP_URL / COUNTERSIGN_PAY_CHAIN_ID,
 * COUNTERSIGN_HOME(상태 폴더), COUNTERSIGN_POLL_MS
 */
export async function walletFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const policyPath = env.COUNTERSIGN_POLICY;
  if (!policyPath) throw new Error("COUNTERSIGN_POLICY(정책 파일 경로)가 필요함");
  const policy = new PolicyFile(policyPath).get();
  const paths = statePaths(env);
  const secretHex = env.COUNTERSIGN_TICKET_SECRET || readOrCreateSharedSecret(paths.ticketSecret, false);
  if (!secretHex) throw new Error("검증 티켓 키가 없음: signer를 먼저 실행하세요");
  const hspConfig = loadHspConfig(env);
  const hsp = await createHspClient(hspConfig);
  const signer = new SignerClient(paths.signerSocket);
  const registry = new AgentRegistry(paths, policyPath);
  const shared: SharedWalletDeps = {
    hsp,
    ticketSecret: parseTicketSecret(secretHex),
    history: new HistoryStore(paths.history),
    pause: () => readPause(paths.pause),
    approvals: new ApprovalStore(paths.approvals),
    tasks: new TaskStore(paths.tasks),
    balances: rpcBalanceReader(env),
    hspMode: hspConfig.mode,
    pollIntervalMs: Number(env.COUNTERSIGN_POLL_MS || 2000),
  };
  const walletFor = walletFactory(registry, signer, shared);
  return { wallet: walletFor()!, walletFor, registry, policy, paths, hspConfig };
}

/** 공유 의존성 (HSP·내역·승인·맡기기·정지·잔액 조회 등). 에이전트별로 달라지는 signer·policy·ledger는 빠진다 */
export type SharedWalletDeps = Omit<WalletDeps, "signer" | "policy" | "ledger">;

/** 에이전트마다 자기 계정·정책·지출 기록을 가진 지갑 (같은 HSP·내역·승인·맡기기 저장소를 공유) */
export function walletFactory(registry: AgentRegistry, signer: SignerClient, shared: SharedWalletDeps) {
  const wallets = new Map<string, WalletService>();
  // 1번 계정을 같이 쓰는 옛 연결들은 지출 기록 파일도 같다: 같은 파일은 한 객체로 (일일 한도가 서로 보이게)
  const ledgers = new Map<string, FileSpendLedger>();
  const ledgerAt = (p: string) => {
    let l = ledgers.get(p);
    if (!l) ledgers.set(p, (l = new FileSpendLedger(p)));
    return l;
  };
  return (agentId?: string): WalletService | undefined => {
    const info = registry.resolve(agentId);
    if (!info) return undefined;
    let w = wallets.get(info.id);
    if (!w) {
      const pf = new PolicyFile(info.policyPath);
      w = new WalletService({
        ...shared,
        signer: signer.forAgent(info.id),
        policy: () => pf.get(),
        ledger: ledgerAt(info.walletLedger),
      });
      wallets.set(info.id, w);
    }
    return w;
  };
}

export function buildMcpServer(wallet: WalletService, caller: string | Caller): McpServer {
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
