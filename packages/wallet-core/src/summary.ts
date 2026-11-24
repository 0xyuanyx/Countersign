import { formatAmount } from "./amount.js";
import { DAY_SECONDS, type Policy, type SpendLedger } from "./policy.js";
import type { PauseState } from "./state.js";

/** 에이전트(get_policy)와 주인 앱(GET /api/policy)이 같이 보는 정책 요약. 금액은 사람이 읽는 USDC 문자열. */
export interface PolicySummary {
  agent: string;
  account_index: number;
  account?: string;
  token: "USDC";
  chains: { chain_id: number; token: string }[];
  per_tx_max: string;
  daily_max: string;
  spent_24h: string;
  remaining_24h: string;
  sellers: { name: string; address: string }[];
  max_authorization_seconds: number;
  paused: boolean;
  paused_reason?: string;
  /** 에이전트가 이 값을 바꿀 방법은 없다 */
  editable_by_agent: false;
}

export function summarizePolicy(
  policy: Policy,
  ledger: SpendLedger,
  pause: PauseState,
  now: number,
  account?: string,
): PolicySummary {
  const spent = ledger.spentSince(now - DAY_SECONDS);
  const remaining = spent >= policy.dailyMax ? 0n : policy.dailyMax - spent;
  return {
    agent: policy.agent,
    account_index: policy.accountIndex,
    ...(account && { account }),
    token: "USDC",
    chains: [...policy.chains].map((c) => ({ chain_id: c, token: policy.tokens.get(c)! })),
    per_tx_max: formatAmount(policy.perTxMax),
    daily_max: formatAmount(policy.dailyMax),
    spent_24h: formatAmount(spent),
    remaining_24h: formatAmount(remaining),
    sellers: [...policy.sellers].map(([name, address]) => ({ name, address })),
    max_authorization_seconds: policy.maxAuthorizationSeconds,
    paused: pause.paused,
    ...(pause.paused && pause.reason && { paused_reason: pause.reason }),
    editable_by_agent: false,
  };
}
