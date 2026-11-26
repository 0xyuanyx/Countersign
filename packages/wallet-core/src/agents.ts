import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectionStore, type Connection } from "./owner-state.js";
import { PolicyFile } from "./policy-file.js";
import type { StatePaths } from "./state.js";

/**
 * 에이전트 = 원격 연결 하나 = 계정 하나 (니모닉 m/44'/60'/0'/0/n) + 정책 파일 하나 + 지출 기록 하나.
 * - 1번 계정은 첫 에이전트. 그 정책은 기존 COUNTERSIGN_POLICY 파일이고 지출 기록도 기존 파일 그대로다.
 *   11/26 이전에 만든 연결(account_index 없음)과 stdio 로컬 에이전트("local")도 1번을 쓴다.
 * - 새 연결은 비어 있는 다음 번호를 받고, 1번 정책을 복사한 자기 정책 파일을 갖는다 (판매자·한도는 같게 시작).
 * 지갑 MCP·signer·주인 API가 같은 규칙으로 에이전트를 찾는다. 키는 signer만 파생한다.
 */
export const LOCAL_AGENT_ID = "local";

export interface AgentInfo {
  /** 연결 id, stdio면 "local" */
  id: string;
  name: string;
  accountIndex: number;
  policyPath: string;
  walletLedger: string;
  signerLedger: string;
  connection?: Connection;
}

export class AgentRegistry {
  readonly connections: ConnectionStore;

  constructor(
    private readonly paths: StatePaths,
    /** 1번 에이전트 정책 (COUNTERSIGN_POLICY) */
    private readonly mainPolicyPath: string,
  ) {
    this.connections = new ConnectionStore(paths.connections);
  }

  static indexOf(c: Connection): number {
    return c.account_index ?? 1;
  }

  /** agentId 없음·"local" → 1번 로컬 에이전트. 모르는 id → undefined */
  resolve(agentId?: string): AgentInfo | undefined {
    if (!agentId || agentId === LOCAL_AGENT_ID) return this.info(undefined, 1);
    const c = this.connections.get(agentId);
    return c ? this.info(c, AgentRegistry.indexOf(c)) : undefined;
  }

  list(): AgentInfo[] {
    return this.connections.list().map((c) => this.info(c, AgentRegistry.indexOf(c)));
  }

  /** 다음 계정 번호: 아직 아무 연결도 1번을 안 쓰면 1, 아니면 쓰인 번호 중 가장 큰 것 + 1 */
  nextIndex(): number {
    const used = this.connections.list().map(AgentRegistry.indexOf);
    if (!used.includes(1)) return 1;
    return Math.max(...used) + 1;
  }

  /** 새 에이전트 연결: 계정 번호를 정하고, 2번 이상이면 1번 정책을 복사해 자기 정책 파일을 만든다 */
  create(name: string, now: number) {
    const index = this.nextIndex();
    const { connection, token } = this.connections.create(name, now, index);
    const info = this.info(connection, index);
    if (index !== 1 && !existsSync(info.policyPath)) {
      const base = new PolicyFile(this.mainPolicyPath).json();
      mkdirSync(join(this.paths.dir, "policies"), { recursive: true, mode: 0o700 });
      const tmp = `${info.policyPath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ ...base, agent: name, accountIndex: index }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, info.policyPath);
      chmodSync(info.policyPath, 0o600);
      new PolicyFile(info.policyPath).get(); // 형식 확인
    }
    return { connection, token, info };
  }

  private info(c: Connection | undefined, index: number): AgentInfo {
    const ledgers = join(this.paths.dir, "ledgers");
    return {
      id: c?.id ?? LOCAL_AGENT_ID,
      name: c?.name ?? "local",
      accountIndex: index,
      policyPath: index === 1 ? this.mainPolicyPath : join(this.paths.dir, "policies", `account-${index}.json`),
      walletLedger: index === 1 ? this.paths.walletLedger : join(ledgers, `wallet-${index}.jsonl`),
      signerLedger: index === 1 ? this.paths.signerLedger : join(ledgers, `signer-${index}.jsonl`),
      ...(c && { connection: c }),
    };
  }
}
