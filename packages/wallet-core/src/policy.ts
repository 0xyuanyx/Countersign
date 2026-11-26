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
    /**
     * 주인 승인을 언제 받나 (기본 unknown_seller).
     * unknown_seller: 등록 판매자는 바로 결제, 처음 보는 판매자 이름은 주인 승인 대기
     * every_payment : 검증을 통과한 모든 결제를 주인 승인 대기 (HSP 가이드의 "서명 전 사람 확인")
     * 어느 쪽이든 등록 판매자 이름 + 다른 주소는 묻지 않고 PAYEE_MISMATCH.
     */
    approvalMode: z.enum(["unknown_seller", "every_payment"]).optional(),
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
  approvalMode: "unknown_seller" | "every_payment";
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
    approvalMode: p.approvalMode ?? "unknown_seller",
  };
}

/** 에이전트가 밝힌 결제 의도. 믿지 않는다: 금액 "상한"과 "판매자 이름"으로만 쓴다. */
export const IntentSchema = z
  .object({
    purpose: z.string().min(1).max(500),
    max_amount: amountText,
    seller: z.string().min(1).max(64),
    /** 주인이 앱에서 맡긴 일(next_task)로 하는 결제면 그 id. 지갑이 그 일의 최대 금액을 강제한다 */
    task_id: z.string().min(1).max(64).optional(),
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
/**
 * 정책 파일 밖에서 오는 주인 결정. 지갑 MCP와 signer가 각자 상태 파일에서 읽어 넘긴다 (에이전트 입력 아님).
 */
export interface CheckExtras {
  /** 주인이 앱에서 승인한 이 주문 (order_ref·받는 주소·금액·체인·토큰이 모두 같아야 효력) */
  approval?: { orderRef: string; payTo: string; amount: bigint; chainId: number; token: string };
  /** intent.task_id가 가리키는 맡긴 일. 없거나 끝난 일이면 undefined */
  task?: { id: string; maxAmount: bigint; active: boolean; status?: string };
}

export function approvalMatches(a: CheckExtras["approval"], o: Order): boolean {
  return (
    !!a &&
    a.orderRef === o.orderRef &&
    sameAddress(a.payTo, o.payTo) &&
    a.amount === o.amount &&
    a.chainId === o.chainId &&
    sameAddress(a.token, o.token)
  );
}

export function checkOrder(
  order: Order,
  intentInput: unknown,
  policy: Policy,
  ledger: SpendLedger,
  now: number,
  extras: CheckExtras = {},
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
  const approved = approvalMatches(extras.approval, order);
  // 등록한 판매자 이름인데 주소가 다름: 묻지 않고 거절 (승인으로도 못 푼다)
  if (sellerAddr && !sameAddress(sellerAddr, order.payTo)) {
    return reject("PAYEE_MISMATCH", step, `pay_to ${order.payTo}가 "${intent.seller}"의 고정 주소가 아님`);
  }
  // 이름은 달라도 주소가 이미 다른 등록 판매자의 것이면 그 판매자로 본다 (이름만 바꿔 승인 요청을 만드는 것 방지)
  const knownAddr = sellerAddr ?? [...policy.sellers.values()].find((a) => sameAddress(a, order.payTo));
  // 처음 보는 판매자는 금액·한도 검사를 먼저 다 하고, 통과하면 맨 끝에서 주인 승인 대기로 돌린다

  if (order.amount === 0n) return reject("INVALID_INPUT", step, "0원 주문");
  if (intent.task_id !== undefined) {
    const t = extras.task;
    if (t && t.id === intent.task_id && t.status === "paused") {
      return reject("TASK_PAUSED", step, `주인이 맡긴 일 ${intent.task_id}을 멈춤`);
    }
    if (!t || t.id !== intent.task_id || !t.active) {
      return reject("INVALID_INPUT", step, `맡긴 일 ${intent.task_id}이 없거나, 주인이 멈추거나 취소했거나, 이미 끝남`);
    }
    if (order.amount > t.maxAmount) {
      return reject("AMOUNT_OVER_INTENT", step, `주문 ${formatAmount(order.amount)} USDC > 맡긴 일의 최대 ${formatAmount(t.maxAmount)} USDC`);
    }
  }
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
  if (!approved) {
    if (!knownAddr) {
      return reject("NEEDS_OWNER_APPROVAL", step, `처음 보는 판매자 "${intent.seller}" (${order.payTo}): 주인 확인 필요`);
    }
    if (policy.approvalMode === "every_payment") {
      return reject("NEEDS_OWNER_APPROVAL", step, "주인 정책: 모든 결제는 주인 확인 후 서명");
    }
  }
  return { ok: true, intent };
}

/** 정책 = 고정 값 또는 "읽을 때마다 파일에서 다시 가져오는" 함수 (주인 앱이 정책을 바꾸면 재시작 없이 반영) */
export type PolicyInput = Policy | (() => Policy);
export function resolvePolicy(p: PolicyInput): Policy {
  return typeof p === "function" ? p() : p;
}
