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
  /** HSP flow_id (가이드 §6: get_order·prepare_payment·query_payment에 쓰는 주문 id). 에이전트에게는 order_ref로 보인다 */
  order_ref: z.string().min(1).max(200),
  /** HSP payment_request_id (create_order가 돌려줌). 결제 조회·복구에 flow_id와 같이 쓴다 */
  payment_request_id: z.string().max(200).optional(),
  /** true면 가스를 플랫폼이 대납 (가이드 §5). false면 서명 금액에 가스가 더해진다 → 지갑은 서명하지 않는다 */
  gas_fee_advanced: z.boolean().optional(),
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

/**
 * prepare_payment 결과 (가이드 §7 예시 필드). typed_data = 가이드의 eip712 (그대로 서명).
 * finalize: finalize_payment에 손대지 않고 돌려줄 값 세 개 (payment_payload, payment_mandate_contents, cart_hash).
 */
export const PrepareResultSchema = z.object({
  order_ref: z.string(),
  typed_data: RawTypedDataSchema,
  /** 잠긴 토큰 승인 금액 (최소 단위). eip712 message.value와 같아야 한다 */
  token_total_raw: uintLike.optional(),
  /** 견적 만료 (RFC3339, 5분) */
  quote_expires_at: z.string().max(64).optional(),
  pay_to: address.optional(),
  payer: address.optional(),
  payment_request_id: z.string().max(200).optional(),
  /** @deprecated finalize.payment_payload와 같은 값 (옛 mock 호환) */
  payment_payload: z.unknown().optional(),
  finalize: z
    .object({ payment_payload: z.unknown(), payment_mandate_contents: z.unknown(), cart_hash: z.string().max(200) })
    .optional(),
});
export type PrepareResult = z.infer<typeof PrepareResultSchema>;

/**
 * 내부 결제 상태. HSP 원래 상태(가이드 §8)는 QueryResult.hsp_status에 그대로 둔다.
 *   payment-submitted/verified/processing/included/timeout → submitted (계속 조회)
 *   payment-safe → payment-safe (확정 아님) / payment-finalized → payment-finalized / payment-failed → failed
 */
export const PaymentStatusSchema = z.enum([
  "pending",
  "submitted",
  "payment-safe",
  "payment-finalized",
  "failed",
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

/** finalize_payment 결과: payment_mandate_json을 submit_payment에 그대로 넘긴다 (가이드 §7) */
export const FinalizeResultSchema = z.object({ payment_id: z.string().min(1), payment_mandate_json: z.unknown().optional() });
export const SubmitResultSchema = z.object({ payment_id: z.string(), tx_hash: hex.optional() });
export const QueryResultSchema = z.object({
  payment_id: z.string(),
  /** 조회한 주문의 flow_id (조회할 때 flow_id를 넘기므로 클라이언트가 채운다) */
  order_ref: z.string().optional(),
  /** HSP 원래 상태 문자열 (payment-included 등) */
  hsp_status: z.string().max(64).optional(),
  /** query_payment의 attribution_verified (팀 귀속 확인). mock은 true */
  attribution_verified: z.boolean().optional(),
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
  /** orderRef = flow_id */
  getOrder(orderRef: string): Promise<RawOrder>;
  /** protocol: get_chain_config 토큰의 payment_protocol (지갑은 eip3009만 서명한다) */
  preparePayment(orderRef: string, payer: string, protocol?: "eip3009" | "permit2"): Promise<PrepareResult>;
  /** prepared: prepare_payment 결과 (finalize 값 세 개를 그대로 넘긴다) */
  finalizePayment(orderRef: string, signature: string, prepared?: PrepareResult): Promise<{ payment_id: string; payment_mandate_json?: unknown }>;
  estimateFee(orderRef: string): Promise<unknown>;
  /** mandate: finalize_payment가 돌려준 payment_mandate_json (그대로) */
  submitPayment(paymentId: string, mandate?: unknown): Promise<{ payment_id: string; tx_hash?: string }>;
  /** paymentId = payment_request_id, orderRef = flow_id (둘 다 넘겨 같은 결제를 조회한다) */
  queryPayment(paymentId: string, orderRef?: string): Promise<QueryResult>;
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
