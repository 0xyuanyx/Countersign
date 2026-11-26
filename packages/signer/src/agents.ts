import { FileSpendLedger, PolicyFile, type AgentRegistry } from "@countersign/wallet-core";
import type { LocalAccount } from "viem";
import type { SignerAgent } from "./signer.js";

/**
 * 에이전트 등록부 → signer가 쓸 에이전트 (계정·정책·지출 기록·끊김/멈춤).
 * derive는 signer 안에서만 니모닉으로 계정을 파생한다. 정책·지출 기록 파일은 열어 둔 것을 다시 쓴다.
 */
export function registryAgents(registry: AgentRegistry, derive: (index: number) => LocalAccount) {
  const ledgers = new Map<string, FileSpendLedger>();
  const policies = new Map<string, PolicyFile>();
  const once = <T>(m: Map<string, T>, k: string, make: () => T) => {
    let v = m.get(k);
    if (!v) m.set(k, (v = make()));
    return v;
  };
  return (id: string): SignerAgent | undefined => {
    const info = registry.resolve(id);
    if (!info) return undefined;
    const pf = once(policies, info.policyPath, () => new PolicyFile(info.policyPath));
    return {
      account: derive(info.accountIndex),
      accountIndex: info.accountIndex,
      policy: () => pf.get(),
      ledger: once(ledgers, info.signerLedger, () => new FileSpendLedger(info.signerLedger)),
      blocked: () => {
        const c = registry.connections.get(id);
        if (!c || c.disconnected_at) return "disconnected";
        return c.paused_at ? "paused" : undefined;
      },
    };
  };
}
