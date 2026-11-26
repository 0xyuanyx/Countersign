import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { buildCartMandate, rawToUsd } from "./cart.js";
import { isAllowedHspUrl } from "./config.js";
import {
  ChainConfigSchema,
  HspError,
  PrepareResultSchema,
  QueryResultSchema,
  RawOrderSchema,
  type ChainConfig,
  type CreateOrderInput,
  type HspClient,
  type HspToolName,
  type PaymentStatus,
  type PrepareResult,
  type QueryResult,
  type RawOrder,
} from "./types.js";

/**
 * HSP 공식 Agentic Payment MCP 서버 클라이언트. 도구 인자 이름은 공식 가이드(docs/hsp-agentic-payment_EN.md)를 따른다:
 *   create_order(merchant_name, pay_to, cart_mandate) → flow_id, payment_request_id, payment_url
 *   get_order(flow_id)
 *   prepare_payment(flow_id, payer, protocol) → eip712, cart_hash, token_total_raw, quote_expires_at, pay_to, payer,
 *                                               payment_request_id, payment_payload, payment_mandate_contents
 *   finalize_payment(signature, payment_payload, payment_mandate_contents, cart_hash) → payment_mandate_json
 *   submit_payment(payment_mandate_json)
 *   query_payment(flow_id, payment_request_id, expected_merchant_name) → status, payment.tx_signature, attribution_verified
 *
 * ⚠️ NOT VERIFIED (§9 #8): 가이드에 응답 모양이 없는 get_order·get_chain_config·query_payment의 세부 키는 아래 adapt*에서
 * 여러 후보를 받아 내부 표준 형태로 바꾼다. 모르면 추측으로 채우지 않고 BAD_RESPONSE로 거절한다 (fail-closed).
 * IP 허용 뒤 connect()가 받아 둔 라이브 입력 스키마(inputSchemas)와 첫 응답을 보고 이 파일만 맞춘다.
 */
export interface McpHspOptions {
  /** 팀 집계용 이름 (가이드 §6). 생성·조회에 항상 같은 값 */
  merchantName: string;
}

export class McpHspClient implements HspClient {
  private client: Client | undefined;
  private chainConfig: ChainConfig | undefined;
  /** 라이브 도구 입력 스키마 (형식 확인용, 로그로 남기지 않는다) */
  inputSchemas: Record<string, unknown> = {};

  constructor(
    private readonly url: string,
    private readonly opts: McpHspOptions = { merchantName: "countersign" },
  ) {
    if (!isAllowedHspUrl(url)) throw new Error("HSP MCP 주소는 https만 (로컬 mock만 http://127.0.0.1)");
  }

  async connect(): Promise<void> {
    const client = new Client({ name: "countersign", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    // 가이드: finalize_payment가 없으면 진행하지 않는다
    const missing = (
      ["get_chain_config", "create_order", "get_order", "prepare_payment", "finalize_payment", "submit_payment", "query_payment"] as const
    ).filter((n) => !names.has(n));
    if (missing.length) throw new Error(`HSP MCP에 필요한 도구 없음: ${missing.join(", ")}`);
    for (const t of tools) this.inputSchemas[t.name] = t.inputSchema;
    this.client = client;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  async getChainConfig(): Promise<ChainConfig> {
    if (!this.chainConfig) this.chainConfig = adaptChainConfig(await this.raw("get_chain_config", {}));
    return this.chainConfig;
  }

  async createOrder(input: CreateOrderInput): Promise<RawOrder> {
    // 네트워크·토큰 값은 get_chain_config에서만 (가이드 §5, AGENTS.md 규칙 9)
    const cfg = await this.getChainConfig();
    const chain = cfg.chains.find((c) => c.chain_id === input.chain_id);
    const coin = chain && Object.entries(chain.tokens).find(([, a]) => a.toLowerCase() === input.token.toLowerCase())?.[0];
    if (!chain || !coin) throw new HspError("create_order", "UNSUPPORTED", "get_chain_config에 없는 체인·토큰");
    const expiresAt = new Date(Date.now() + (input.ttl_seconds ?? 600) * 1000);
    const cart = buildCartMandate({
      id: `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      usd: rawToUsd(input.amount),
      amountRaw: input.amount,
      label: input.description ?? "Countersign order",
      network: chain.name,
      chainId: chain.chain_id,
      token: input.token,
      coin,
      payTo: input.pay_to,
      expiresAt,
    });
    const res = z
      .object({ flow_id: z.string().min(1), payment_request_id: z.string().min(1), payment_url: z.string().optional() })
      .passthrough()
      .safeParse(await this.raw("create_order", { merchant_name: this.opts.merchantName, pay_to: input.pay_to, cart_mandate: cart }));
    if (!res.success) throw new HspError("create_order", "BAD_RESPONSE", "flow_id·payment_request_id가 없음 (§9 #8)");
    return RawOrderSchema.parse({
      order_ref: res.data.flow_id,
      payment_request_id: res.data.payment_request_id,
      pay_to: input.pay_to,
      amount: input.amount,
      chain_id: input.chain_id,
      token: input.token,
      expires_at: Math.floor(expiresAt.getTime() / 1000),
      ...(input.description && { description: input.description }),
    });
  }

  async getOrder(orderRef: string): Promise<RawOrder> {
    const order = adaptOrder(orderRef, await this.raw("get_order", { flow_id: orderRef }));
    const p = RawOrderSchema.safeParse(order);
    if (!p.success) throw new HspError("get_order", "BAD_RESPONSE", "주문 응답 형식이 예상과 다름 (§9 #8)");
    return p.data;
  }

  async preparePayment(orderRef: string, payer: string, protocol: "eip3009" | "permit2" = "eip3009"): Promise<PrepareResult> {
    const raw = (await this.raw("prepare_payment", { flow_id: orderRef, payer, protocol })) as Record<string, unknown>;
    const p = PrepareResultSchema.safeParse({
      order_ref: orderRef,
      typed_data: raw.eip712,
      token_total_raw: raw.token_total_raw,
      quote_expires_at: raw.quote_expires_at,
      pay_to: raw.pay_to,
      payer: raw.payer,
      payment_request_id: raw.payment_request_id,
      finalize: { payment_payload: raw.payment_payload, payment_mandate_contents: raw.payment_mandate_contents, cart_hash: raw.cart_hash },
    });
    if (!p.success || raw.cart_hash === undefined) throw new HspError("prepare_payment", "BAD_RESPONSE", "eip712·cart_hash 등 필드가 없음 (§9 #8)");
    return p.data;
  }

  async finalizePayment(orderRef: string, signature: string, prepared?: PrepareResult): Promise<{ payment_id: string; payment_mandate_json?: unknown }> {
    if (!prepared?.finalize) throw new HspError("finalize_payment", "NOT_PREPARED", "prepare_payment 결과가 필요");
    // 가이드: 세 값을 받은 그대로 넘긴다. 서명을 payload에 직접 넣지 않는다
    const raw = (await this.raw("finalize_payment", {
      signature,
      payment_payload: prepared.finalize.payment_payload,
      payment_mandate_contents: prepared.finalize.payment_mandate_contents,
      cart_hash: prepared.finalize.cart_hash,
    })) as Record<string, unknown>;
    if (raw?.payment_mandate_json === undefined) throw new HspError("finalize_payment", "BAD_RESPONSE", "payment_mandate_json이 없음");
    return { payment_id: prepared.payment_request_id ?? orderRef, payment_mandate_json: raw.payment_mandate_json };
  }

  async estimateFee(orderRef: string): Promise<unknown> {
    return this.raw("estimate_fee", { flow_id: orderRef });
  }

  async submitPayment(paymentId: string, mandate?: unknown): Promise<{ payment_id: string; tx_hash?: string }> {
    if (mandate === undefined) throw new HspError("submit_payment", "NOT_FINALIZED", "payment_mandate_json이 필요");
    // payment_mandate_json이 유일한 입력 (손대지 않는다)
    await this.raw("submit_payment", { payment_mandate_json: mandate });
    return { payment_id: paymentId };
  }

  async queryPayment(paymentId: string, orderRef?: string): Promise<QueryResult> {
    const raw = await this.raw("query_payment", {
      ...(orderRef && { flow_id: orderRef }),
      payment_request_id: paymentId,
      expected_merchant_name: this.opts.merchantName,
    });
    const q = adaptQuery(paymentId, orderRef, raw);
    const p = QueryResultSchema.safeParse(q);
    if (!p.success) throw new HspError("query_payment", "BAD_RESPONSE", "조회 응답 형식이 예상과 다름 (§9 #8)");
    return p.data;
  }

  private async raw(tool: HspToolName, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error("connect() 먼저");
    const res = await this.client.callTool({ name: tool, arguments: args });
    if (res.isError) {
      const text = textOf(res.content);
      const code = /\b(\d{5})\b/.exec(text)?.[1];
      throw new HspError(tool, code ? Number(code) : undefined, text.slice(0, 300));
    }
    if (res.structuredContent) return res.structuredContent;
    const text = textOf(res.content);
    try {
      return JSON.parse(text);
    } catch {
      throw new HspError(tool, "BAD_RESPONSE", "JSON이 아닌 응답");
    }
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

// ─── 응답 → 내부 표준 형태 (가이드에 모양이 없는 부분, ⚠️ §9 #8) ─────────────────

const pick = (o: Record<string, unknown> | undefined, ...keys: string[]) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

/** get_chain_config: tokens[].address·decimals·payment_protocol (가이드 §5). 바깥 모양은 후보 몇 개를 받는다 */
export function adaptChainConfig(raw: unknown): ChainConfig {
  const r = raw as Record<string, unknown>;
  const list = (Array.isArray(raw) ? raw : (pick(r, "chains", "networks", "data") as unknown[])) ?? [];
  const chains = (Array.isArray(list) ? list : []).map((c) => {
    const o = c as Record<string, unknown>;
    const tokensRaw = pick(o, "tokens");
    const tokens: Record<string, string> = {};
    if (Array.isArray(tokensRaw)) {
      for (const t of tokensRaw as Record<string, unknown>[]) {
        // eip3009 토큰만 쓴다 (지갑은 TransferWithAuthorization만 서명)
        if (t.payment_protocol && t.payment_protocol !== "eip3009") continue;
        const sym = pick(t, "symbol", "coin", "name");
        const addr = pick(t, "address", "contract_address");
        if (typeof sym === "string" && typeof addr === "string") tokens[sym] = addr;
      }
    } else if (tokensRaw && typeof tokensRaw === "object") Object.assign(tokens, tokensRaw);
    return { chain_id: Number(pick(o, "chain_id", "chainId")), name: String(pick(o, "network", "name") ?? ""), tokens };
  });
  const p = ChainConfigSchema.safeParse({ chains });
  if (!p.success) throw new HspError("get_chain_config", "BAD_RESPONSE", "체인 설정 형식이 예상과 다름 (§9 #8)");
  return p.data;
}

/** get_order 응답 → RawOrder. 최소 단위 금액이 없으면 추측하지 않고 실패시킨다 (USD 소수 금액만 오면 §9 #8에 따라 adapter를 고친다) */
export function adaptOrder(flowId: string, raw: unknown): unknown {
  const r = (raw ?? {}) as Record<string, unknown>;
  const order = ((pick(r, "order", "data") as Record<string, unknown>) ?? r) as Record<string, unknown>;
  const expiry = pick(order, "expires_at", "cart_expiry", "expired_at");
  return {
    order_ref: flowId,
    payment_request_id: pick(order, "payment_request_id"),
    pay_to: pick(order, "pay_to", "to_pay_address"),
    amount: pick(order, "amount", "amount_raw", "token_total_raw"),
    chain_id: Number(pick(order, "chain_id", "chainId")),
    token: pick(order, "token", "contract_address", "token_address"),
    expires_at: typeof expiry === "string" ? Math.floor(Date.parse(expiry) / 1000) : expiry,
    gas_fee_advanced: pick(order, "gas_fee_advanced"),
    status: pick(order, "status"),
  };
}

const HSP_STATUS: Record<string, PaymentStatus> = {
  "payment-submitted": "submitted",
  "payment-verified": "submitted",
  "payment-processing": "submitted",
  "payment-included": "submitted",
  "payment-timeout": "submitted",
  "payment-safe": "payment-safe",
  "payment-finalized": "payment-finalized",
  "payment-failed": "failed",
};

/** query_payment: status, payment.tx_signature, attribution_verified (가이드 §8). 모르는 상태는 지어내지 않고 실패시킨다 */
export function adaptQuery(paymentId: string, flowId: string | undefined, raw: unknown): unknown {
  const r = (raw ?? {}) as Record<string, unknown>;
  const payment = (pick(r, "payment") ?? {}) as Record<string, unknown>;
  const st = String(pick(r, "status") ?? pick(payment, "status") ?? "");
  const tx = pick(payment, "tx_signature") ?? pick(r, "tx_signature");
  return {
    payment_id: paymentId,
    ...(flowId && { order_ref: String(pick(r, "flow_id") ?? flowId) }),
    status: HSP_STATUS[st] ?? st, // 모르는 상태면 스키마에서 걸러져 BAD_RESPONSE
    hsp_status: st,
    ...(typeof tx === "string" && tx && { tx_hash: tx }),
    ...(typeof pick(r, "attribution_verified") === "boolean" && { attribution_verified: pick(r, "attribution_verified") }),
  };
}
