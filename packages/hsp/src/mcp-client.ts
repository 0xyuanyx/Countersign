import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { z } from "zod";
import {
  ChainConfigSchema,
  FinalizeResultSchema,
  HspError,
  PrepareResultSchema,
  QueryResultSchema,
  RawOrderSchema,
  SubmitResultSchema,
  type ChainConfig,
  type CreateOrderInput,
  type HspClient,
  type HspToolName,
  type PrepareResult,
  type QueryResult,
  type RawOrder,
} from "./types.js";

/**
 * HSP 공식 Agentic Payment MCP 서버 클라이언트.
 *
 * ⚠️ NOT VERIFIED: 도구 인자 이름과 응답 형태는 HSP 가이드 원문 확인 전이다 (PROJECT.md §9 #1, #8).
 * 추측이 들어간 곳은 `args`(인자 이름)와 `adapt`(응답 → 내부 표준 형태) 두 곳뿐이다.
 * 형식이 확인되면 이 두 곳만 고친다. 응답은 항상 zod로 검증한 뒤 넘긴다.
 */
export class McpHspClient implements HspClient {
  private client: Client | undefined;

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    const client = new Client({ name: "countersign", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    const missing = (
      ["get_order", "prepare_payment", "finalize_payment", "submit_payment", "query_payment"] as const
    ).filter((n) => !names.has(n));
    if (missing.length) throw new Error(`HSP MCP에 필요한 도구 없음: ${missing.join(", ")}`);
    this.client = client;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  getChainConfig(): Promise<ChainConfig> {
    return this.call("get_chain_config", {}, ChainConfigSchema);
  }
  createOrder(input: CreateOrderInput): Promise<RawOrder> {
    return this.call("create_order", { ...input }, RawOrderSchema);
  }
  getOrder(orderRef: string): Promise<RawOrder> {
    return this.call("get_order", { order_ref: orderRef }, RawOrderSchema);
  }
  preparePayment(orderRef: string, payer: string): Promise<PrepareResult> {
    return this.call("prepare_payment", { order_ref: orderRef, payer }, PrepareResultSchema);
  }
  finalizePayment(orderRef: string, signature: string, paymentPayload?: unknown): Promise<{ payment_id: string }> {
    return this.call(
      "finalize_payment",
      { order_ref: orderRef, signature, payment_payload: paymentPayload },
      FinalizeResultSchema,
    );
  }
  async estimateFee(orderRef: string): Promise<unknown> {
    return this.raw("estimate_fee", { order_ref: orderRef });
  }
  submitPayment(paymentId: string): Promise<{ payment_id: string; tx_hash?: string }> {
    return this.call("submit_payment", { payment_id: paymentId }, SubmitResultSchema);
  }
  queryPayment(paymentId: string): Promise<QueryResult> {
    return this.call("query_payment", { payment_id: paymentId }, QueryResultSchema);
  }

  private async call<S extends z.ZodType>(tool: HspToolName, args: Record<string, unknown>, schema: S): Promise<z.infer<S>> {
    const raw = await this.raw(tool, args);
    const parsed = schema.safeParse(adapt(tool, raw));
    if (!parsed.success) throw new HspError(tool, "BAD_RESPONSE", "응답 형식이 예상과 다름 (§9 #8)");
    return parsed.data;
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

/** 실제 HSP 응답 → 내부 표준 형태. 형식 확인 전이라 지금은 그대로 넘긴다 (§9 #8). */
function adapt(_tool: HspToolName, raw: unknown): unknown {
  return raw;
}
