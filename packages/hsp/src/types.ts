import { z } from "zod";

/**
 * HSP 공식 Agentic Payment MCP 서버의 도구 8개 (PROJECT.md §4.1).
 * 이름은 공개 경쟁작 README 기준. 가이드 원문으로 다시 확인해야 한다 (§9 #1).
 */
export const HSP_TOOLS = [
  "get_chain_config",
  "create_order",
  "get_order",
  "prepare_payment",
  "finalize_payment",
  "estimate_fee",
  "submit_payment",
  "query_payment",
] as const;
export type HspToolName = (typeof HSP_TOOLS)[number];

/*
 * ⚠️ ASSUMED (§9 #8): 아래 응답 형태는 HSP 가이드 원문을 아직 못 봐서 우리가 정한 "내부 표준 형태"다.
 * 실제 HSP 응답은 mcp-client.ts의 adapter에서 이 형태로 바꾼다. 형태가 확인되면 adapter만 고친다.
 * wallet-core는 이 형태만 본다.
 */

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "hex 문자열이 아님");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "주소 형식이 아님");
/** 금액·uint는 문자열(10진 정수 또는 0x hex)이나 안전 정수로 온다. bigint 변환은 wallet-core/amount.ts에서만 한다. */
const uintLike = z.union([z.string().regex(/^(0x[0-9a-fA-F]+|\d+)$/), z.number().int().nonnegative()]);

export const RawOrderSchema = z.object({
  order_ref: z.string().min(1).max(200),
  /** 수취인 (판매자 고정 주소여야 함) */
  pay_to: address,
  /** 최소 단위 정수 문자열 (USDC 6 decimals). 사람이 읽는 "0.10" 형식이 오면 adapter에서 변환 */
  amount: uintLike,
  chain_id: z.number().int().positive(),
  /** 토큰 컨트랙트 주소 */
  token: address,
  /** 주문 만료 (unix seconds) */
  expires_at: z.number().int().positive(),
  description: z.string().max(2000).optional(),
  merchant_id: z.string().max(200).optional(),
  status: z.string().max(100).optional(),
});
export type RawOrder = z.infer<typeof RawOrderSchema>;

export const RawTypedDataSchema = z.object({
  domain: z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    chainId: uintLike,
    verifyingContract: address,
    salt: hex.optional(),
  }),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});
export type RawTypedData = z.infer<typeof RawTypedDataSchema>;

export const PrepareResultSchema = z.object({
  order_ref: z.string(),
  typed_data: RawTypedDataSchema,
  /** finalize_payment에 그대로 돌려줄 불투명 값 */
  payment_payload: z.unknown().optional(),
});
export type PrepareResult = z.infer<typeof PrepareResultSchema>;

export const PaymentStatusSchema = z.enum([
  "pending",
  "submitted",
  "payment-safe",
  "payment-finalized",
  "failed",
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const FinalizeResultSchema = z.object({ payment_id: z.string().min(1) });
export const SubmitResultSchema = z.object({ payment_id: z.string(), tx_hash: hex.optional() });
export const QueryResultSchema = z.object({
  payment_id: z.string(),
  /** ⚠️ ASSUMED (§9 #8): 판매자가 "이 결제가 내 주문 것인지" 확인하려면 필요. 실제 응답에 없으면 adapter에서 get_order로 채운다 */
  order_ref: z.string().optional(),
  status: PaymentStatusSchema,
  tx_hash: hex.optional(),
  chain_id: z.number().int().positive().optional(),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

export const ChainConfigSchema = z.object({
  chains: z.array(
    z.object({ chain_id: z.number().int().positive(), name: z.string(), tokens: z.record(z.string(), address) }),
  ),
});
export type ChainConfig = z.infer<typeof ChainConfigSchema>;

export interface CreateOrderInput {
  pay_to: string;
  /** 최소 단위 정수 문자열 */
  amount: string;
  chain_id: number;
  token: string;
  description?: string;
  ttl_seconds?: number;
}

/** HSP 공식 MCP 서버에 대한 클라이언트 인터페이스. 실서버(mcp-client.ts)와 mock(mock.ts)이 같은 모양을 따른다. */
export interface HspClient {
  getChainConfig(): Promise<ChainConfig>;
  createOrder(input: CreateOrderInput): Promise<RawOrder>;
  getOrder(orderRef: string): Promise<RawOrder>;
  preparePayment(orderRef: string, payer: string): Promise<PrepareResult>;
  finalizePayment(orderRef: string, signature: string, paymentPayload?: unknown): Promise<{ payment_id: string }>;
  estimateFee(orderRef: string): Promise<unknown>;
  submitPayment(paymentId: string): Promise<{ payment_id: string; tx_hash?: string }>;
  queryPayment(paymentId: string): Promise<QueryResult>;
}

export class HspError extends Error {
  constructor(
    readonly tool: HspToolName,
    readonly hspCode: string | number | undefined,
    message: string,
  ) {
    super(`${tool}: ${message}`);
    this.name = "HspError";
  }
}
