import { KNOWN_USDC } from "@countersign/hsp";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { formatAmount, parseAmount } from "./amount.js";
import { sameAddress, type Order } from "./order.js";
import { reject, type Rejection } from "./rejection.js";

/**
 * 정책 = 사람이 한 번만 정하는 값 (PROJECT.md §5.5). MCP 도구로 바꿀 수 없다 (AGENTS.md 규칙 4).
 * 한도는 오프체인 건당·일일 상한 + 허용 판매자 정도만 다룬다 (온체인 누적 한도는 팀 작품 영역).
 */
const addressSchema = z.string().refine((a) => isAddress(a, { strict: false }), "주소 형식이 아님");
const amountText = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/, "금액은 \"0.50\" 같은 문자열");

export const PolicyFileSchema = z
  .object({
    agent: z.string().min(1).max(64),
    accountIndex: z.number().int().min(1).max(1000),
    chains: z.array(z.number().int().positive()).min(1),
    token: z.literal("USDC"),
    perTxMax: amountText,
    dailyMax: amountText,
    sellers: z.record(z.string().min(1).max(64), addressSchema),
    /** KNOWN_USDC에 없는 체인(예: Sepolia 계열)의 USDC 주소 */
    tokenAddresses: z.record(z.string().regex(/^\d+$/), addressSchema).optional(),
    /** EIP-3009 서명 유효 시간 상한 (초). 기본 3600 */
    maxAuthorizationSeconds: z.number().int().min(30).max(86400).optional(),
  })
  .strict();

export interface Policy {
  agent: string;
  accountIndex: number;
  chains: ReadonlySet<number>;
  /** chainId → 허용 USDC 주소 */
  tokens: ReadonlyMap<number, Address>;
  perTxMax: bigint;
  dailyMax: bigint;
  sellers: ReadonlyMap<string, Address>;
  maxAuthorizationSeconds: number;
}

export function parsePolicy(json: unknown): Policy {
  const p = PolicyFileSchema.parse(json);
  const tokens = new Map<number, Address>();
  for (const chainId of p.chains) {
    const override = p.tokenAddresses?.[String(chainId)];
    const addr = override ?? KNOWN_USDC[chainId];
    if (!addr) throw new Error(`정책: 체인 ${chainId}의 USDC 주소가 없음 (tokenAddresses에 추가)`);
    tokens.set(chainId, getAddress(addr));
  }
  const perTxMax = parseAmount(p.perTxMax);
  const dailyMax = parseAmount(p.dailyMax);
  if (perTxMax > dailyMax) throw new Error("정책: perTxMax가 dailyMax보다 큼");
  return {
    agent: p.agent,
    accountIndex: p.accountIndex,
    chains: new Set(p.chains),
    tokens,
    perTxMax,
    dailyMax,
    sellers: new Map(Object.entries(p.sellers).map(([k, v]) => [k, getAddress(v)])),
    maxAuthorizationSeconds: p.maxAuthorizationSeconds ?? 3600,
  };
}

/** 에이전트가 밝힌 결제 의도. 믿지 않는다: 금액 "상한"과 "판매자 이름"으로만 쓴다. */
export const IntentSchema = z
  .object({
    purpose: z.string().min(1).max(500),
    max_amount: amountText,
    seller: z.string().min(1).max(64),
  })
  .strict();
export type Intent = z.infer<typeof IntentSchema>;

/** 지출 기록 (일일 한도, 중복 결제). 일일 = 최근 24시간 (시간대 문제를 피하려고 달력 날짜를 쓰지 않음). */
export interface SpendLedger {
  spentSince(sinceUnix: number): bigint;
  isPaid(orderRef: string): boolean;
  record(orderRef: string, amount: bigint, atUnix: number): void;
}

export class MemorySpendLedger implements SpendLedger {
  private readonly entries: { orderRef: string; amount: bigint; at: number }[] = [];
  private readonly paid = new Set<string>();

  spentSince(since: number): bigint {
    return this.entries.filter((e) => e.at > since).reduce((s, e) => s + e.amount, 0n);
  }
  isPaid(orderRef: string): boolean {
    return this.paid.has(orderRef);
  }
  record(orderRef: string, amount: bigint, at: number): void {
    if (this.paid.has(orderRef)) throw new Error("이미 기록된 주문");
    this.paid.add(orderRef);
    this.entries.push({ orderRef, amount, at });
  }
}

export const DAY_SECONDS = 86_400;

/**
 * 주문(get_order로 다시 가져온 값)을 정책·의도와 대조한다. PROJECT.md §5.1 4단계.
 * 순서: 중복 → 만료 → 체인·토큰 → 판매자 → 의도 금액 → 건당·일일 한도
 */
export function checkOrder(
  order: Order,
  intentInput: unknown,
  policy: Policy,
  ledger: SpendLedger,
  now: number,
): { ok: true; intent: Intent } | Rejection {
  const step = "policy";
  const parsed = IntentSchema.safeParse(intentInput);
  if (!parsed.success) return reject("INVALID_INPUT", step, "intent 형식이 맞지 않음");
  const intent = parsed.data;

  if (ledger.isPaid(order.orderRef)) return reject("DUPLICATE", step, "이미 결제한 주문");
  if (order.expiresAt <= now) return reject("EXPIRED", step, "주문이 만료됨");

  if (!policy.chains.has(order.chainId)) {
    return reject("CHAIN_OR_TOKEN_NOT_ALLOWED", step, `허용 안 된 체인 ${order.chainId}`);
  }
  const allowedToken = policy.tokens.get(order.chainId);
  if (!allowedToken || !sameAddress(allowedToken, order.token)) {
    return reject("CHAIN_OR_TOKEN_NOT_ALLOWED", step, `허용 안 된 토큰 ${order.token}`);
  }

  const sellerAddr = policy.sellers.get(intent.seller);
  if (!sellerAddr) return reject("PAYEE_MISMATCH", step, `허용 목록에 없는 판매자 "${intent.seller}"`);
  if (!sameAddress(sellerAddr, order.payTo)) {
    return reject("PAYEE_MISMATCH", step, `pay_to ${order.payTo}가 "${intent.seller}"의 고정 주소가 아님`);
  }

  if (order.amount === 0n) return reject("INVALID_INPUT", step, "0원 주문");
  const maxByIntent = parseAmount(intent.max_amount);
  if (order.amount > maxByIntent) {
    return reject(
      "AMOUNT_OVER_INTENT",
      step,
      `주문 ${formatAmount(order.amount)} USDC > 의도 상한 ${intent.max_amount} USDC`,
    );
  }
  if (order.amount > policy.perTxMax) {
    return reject("OVER_LIMIT", step, `건당 상한 ${formatAmount(policy.perTxMax)} USDC 초과`);
  }
  const spent = ledger.spentSince(now - DAY_SECONDS);
  if (spent + order.amount > policy.dailyMax) {
    return reject(
      "OVER_LIMIT",
      step,
      `일일 상한 초과 (24시간 사용 ${formatAmount(spent)} / 상한 ${formatAmount(policy.dailyMax)} USDC)`,
    );
  }
  return { ok: true, intent };
}
