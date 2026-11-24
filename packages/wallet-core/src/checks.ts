import { formatAmount, parseAmount } from "./amount.js";
import type { TwaTypedData } from "./evidence.js";
import { sameAddress, type Order } from "./order.js";
import type { Policy } from "./policy.js";

/**
 * 주인 앱 "결제 상세" 화면용 필드별 대조표 (design/README.md 내역·상세).
 * 판정은 checkOrder/checkTypedData가 한다. 이 함수는 사람에게 보여 줄 기준값·실제값만 만든다.
 * 값이 없어서 비교하지 못한 칸은 "unchecked".
 */
export type CheckField = "payee" | "amount" | "chain" | "token" | "expiry" | "signer";
export interface FieldCheck {
  field: CheckField;
  /** needs_approval: 처음 보는 판매자라 주인에게 묻는 중 (앱의 주황 칸) */
  result: "match" | "mismatch" | "needs_approval" | "unchecked";
  expected?: string;
  actual?: string;
}

export function describeChecks(args: {
  policy: Policy;
  intent?: unknown;
  order?: Order;
  td?: TwaTypedData;
  agent?: string;
  now: number;
  /** 주인이 이 주문을 승인했는지 */
  approved?: boolean;
}): FieldCheck[] {
  const { policy, order, td, agent, now } = args;
  const intent = (args.intent && typeof args.intent === "object" ? args.intent : {}) as Record<string, unknown>;
  const seller = typeof intent.seller === "string" ? intent.seller : undefined;
  const out: FieldCheck[] = [];
  const cmp = (field: CheckField, ok: boolean | undefined, expected?: string, actual?: string) =>
    out.push({ field, result: ok === undefined ? "unchecked" : ok ? "match" : "mismatch", expected, actual });

  // 받는 주소: 정책의 판매자 고정 주소 = 주문 pay_to (= 서명 대상 to)
  const fixed = seller ? policy.sellers.get(seller) : undefined;
  const payTo = order?.payTo;
  const knownByAddress = payTo ? [...policy.sellers.values()].find((a) => sameAddress(a, payTo)) : undefined;
  if (order && !fixed && knownByAddress) {
    cmp("payee", !td || sameAddress(td.message.to, payTo!), knownByAddress, payTo);
  } else if (order && !fixed && seller) {
    out.push({
      field: "payee",
      result: args.approved ? "match" : "needs_approval",
      expected: args.approved ? "주인 승인" : `처음 보는 판매자: ${seller}`,
      actual: payTo,
    });
  } else cmp(
    "payee",
    fixed && payTo ? sameAddress(fixed, payTo) && (!td || sameAddress(td.message.to, payTo)) : order && seller ? false : undefined,
    fixed ?? (seller ? `허용 목록에 없음: ${seller}` : undefined),
    td && payTo && !sameAddress(td.message.to, payTo) ? `${payTo} / 서명 대상 ${td.message.to}` : payTo,
  );

  // 금액: min(의도 상한, 건당 상한) 이하, 서명 대상 value와 같음
  let cap = policy.perTxMax;
  try {
    if (typeof intent.max_amount === "string") {
      const m = parseAmount(intent.max_amount);
      if (m < cap) cap = m;
    }
  } catch {
    // 형식 오류는 checkOrder가 INVALID_INPUT으로 처리
  }
  cmp(
    "amount",
    order ? order.amount <= cap && (!td || td.message.value === order.amount) : undefined,
    `≤ ${formatAmount(cap)} USDC`,
    order ? `${formatAmount(order.amount)} USDC${td && td.message.value !== order.amount ? ` / 서명 대상 ${formatAmount(td.message.value)}` : ""}` : undefined,
  );

  cmp(
    "chain",
    order ? policy.chains.has(order.chainId) && (!td || td.domain.chainId === order.chainId) : undefined,
    [...policy.chains].join(", "),
    order ? String(order.chainId) + (td && td.domain.chainId !== order.chainId ? ` / 서명 대상 ${td.domain.chainId}` : "") : undefined,
  );

  const allowedToken = order ? policy.tokens.get(order.chainId) : undefined;
  cmp(
    "token",
    order ? !!allowedToken && sameAddress(allowedToken, order.token) && (!td || sameAddress(td.domain.verifyingContract, order.token)) : undefined,
    allowedToken ?? "USDC",
    order?.token,
  );

  cmp(
    "expiry",
    td ? td.message.validBefore > BigInt(now) && td.message.validBefore <= BigInt(now + policy.maxAuthorizationSeconds) : order ? order.expiresAt > now : undefined,
    `${now} < 만료 ≤ ${now + policy.maxAuthorizationSeconds}`,
    td ? td.message.validBefore.toString() : order ? String(order.expiresAt) : undefined,
  );

  cmp("signer", td && agent ? sameAddress(td.message.from, agent) : undefined, agent, td?.message.from);
  return out;
}
