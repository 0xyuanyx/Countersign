import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MockHsp, type MockHspOptions } from "./mock.js";
import { readCartMandate } from "./cart.js";
import { HspError } from "./types.js";

/**
 * HSP mock을 "공식 MCP 서버와 같은 모양"(도구 8개, Streamable HTTP)으로 띄운다.
 * 판매 서버와 구매자 지갑이 같은 mock을 공유해야 하므로 프로세스 밖 서버로 둔다.
 * 지갑·판매 서버는 실서버와 똑같이 McpHspClient로 붙는다 → 실서버로 바꿀 때 주소만 바뀐다.
 *
 * 127.0.0.1에만 연다. mock이라 돈은 움직이지 않고 tx_hash도 가짜다 (README에서 VERIFIED로 쓰지 않는다).
 * ⚠️ 도구 인자 이름은 mcp-client.ts의 추측(§9 #8)과 맞춘 것이다.
 */
export interface MockHspServer {
  url: string;
  hsp: MockHsp;
  close(): Promise<void>;
}

export async function serveMockHsp(opts: MockHspOptions & { port?: number; merchantName?: string }): Promise<MockHspServer> {
  const hsp = new MockHsp(opts);
  // 요청마다 MCP 서버를 새로 만들기 때문에 prepare 결과는 바깥에 둔다
  const prepared = new Map<string, Prepared>();

  const http: Server = createServer(async (req, res) => {
    if (req.url !== "/mcp" && req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      // 상태 없는(stateless) 서버라 GET 스트림·DELETE 세션은 지원하지 않는다
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const server = buildServer(hsp, opts.merchantName, prepared);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    hsp,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

type Prepared = Awaited<ReturnType<MockHsp["preparePayment"]>>;

function buildServer(hsp: MockHsp, merchantName: string | undefined, prepared: Map<string, Prepared>): McpServer {
  const server = new McpServer({ name: "hsp-mock", version: "0.0.0" });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }] };
    } catch (e) {
      const text =
        e instanceof HspError ? `${e.hspCode ?? "ERROR"} ${e.message}` : e instanceof Error ? `INVALID ${e.message}` : "INTERNAL mock 처리 중 오류";
      return { isError: true, content: [{ type: "text" as const, text }] };
    }
  };
  // 도구 인자 이름은 공식 가이드(docs/hsp-agentic-payment_EN.md §6~8)를 따른다. 응답의 세부 모양 중 가이드에 없는 것은 mcp-client.ts의 adapt*와 맞춘 가정이다
  const flowId = { flow_id: z.string().min(1).max(200) };

  server.registerTool("get_chain_config", { description: "지원 체인·토큰" }, () =>
    run(async () => {
      const c = await hsp.getChainConfig();
      return {
        networks: c.chains.map((x) => ({
          network: x.name,
          chain_id: x.chain_id,
          tokens: Object.entries(x.tokens).map(([symbol, address]) => ({ symbol, address, decimals: 6, payment_protocol: "eip3009" })),
        })),
      };
    }),
  );
  server.registerTool(
    "create_order",
    { description: "판매자 주문 생성", inputSchema: { merchant_name: z.string().min(1), pay_to: z.string(), cart_mandate: z.unknown() } },
    (a) =>
      run(async () => {
        if (merchantName && a.merchant_name !== merchantName) throw new HspError("create_order", "BAD_MERCHANT", "merchant_name이 다름");
        const cart = readCartMandate(a.cart_mandate);
        const ttl = cart.expiresAt ? Math.max(1, cart.expiresAt - Math.floor(Date.now() / 1000)) : 600;
        const o = await hsp.createOrder({ pay_to: a.pay_to, amount: cart.amountRaw, chain_id: cart.chainId, token: cart.token, ...(cart.label && { description: cart.label }), ttl_seconds: ttl });
        return { flow_id: o.order_ref, payment_request_id: o.payment_request_id, payment_url: `https://mock.invalid/pay/${o.order_ref}` };
      }),
  );
  server.registerTool("get_order", { description: "주문 조회", inputSchema: flowId }, (a) => run(() => hsp.getOrder(a.flow_id)));
  server.registerTool(
    "prepare_payment",
    { description: "EIP-3009 서명 대상 만들기", inputSchema: { ...flowId, payer: z.string(), protocol: z.enum(["eip3009", "permit2"]) } },
    (a) =>
      run(async () => {
        if (a.protocol !== "eip3009") throw new HspError("prepare_payment", "UNSUPPORTED", "mock은 eip3009만");
        const p = await hsp.preparePayment(a.flow_id, a.payer);
        prepared.set(p.order_ref, p);
        return {
          eip712: p.typed_data,
          cart_hash: p.finalize!.cart_hash,
          token_total_raw: p.token_total_raw,
          quote_expires_at: p.quote_expires_at,
          pay_to: p.pay_to,
          payer: p.payer,
          payment_request_id: p.payment_request_id,
          payment_payload: p.finalize!.payment_payload,
          payment_mandate_contents: p.finalize!.payment_mandate_contents,
        };
      }),
  );
  server.registerTool(
    "finalize_payment",
    {
      description: "서명 넣고 payment_mandate_json 만들기",
      inputSchema: { signature: z.string(), payment_payload: z.unknown(), payment_mandate_contents: z.unknown(), cart_hash: z.string() },
    },
    (a) =>
      run(async () => {
        const ref = (a.payment_payload as { flow_id?: string })?.flow_id;
        const p = ref ? prepared.get(ref) : undefined;
        if (!ref || !p || p.finalize!.cart_hash !== a.cart_hash) throw new HspError("finalize_payment", "NOT_PREPARED", "prepare_payment 값이 아님");
        const r = await hsp.finalizePayment(ref, a.signature, p);
        return { payment_mandate_json: r.payment_mandate_json };
      }),
  );
  server.registerTool("estimate_fee", { description: "수수료 추정", inputSchema: flowId }, (a) => run(() => hsp.estimateFee(a.flow_id)));
  server.registerTool("submit_payment", { description: "relayer 제출", inputSchema: { payment_mandate_json: z.unknown() } }, (a) =>
    run(async () => {
      const m = a.payment_mandate_json as { payment_request_id?: string };
      if (!m?.payment_request_id) throw new HspError("submit_payment", "BAD_MANDATE", "payment_mandate_json이 아님");
      await hsp.submitPayment(m.payment_request_id, m);
      return { status: "payment-submitted" };
    }),
  );
  server.registerTool(
    "query_payment",
    {
      description: "결제 상태",
      inputSchema: { flow_id: z.string().optional(), payment_request_id: z.string().optional(), expected_merchant_name: z.string().optional() },
    },
    (a) =>
      run(async () => {
        const q = await hsp.queryPayment(a.payment_request_id ?? "", a.flow_id);
        return {
          status: q.hsp_status,
          flow_id: q.order_ref,
          attribution_verified: !merchantName || a.expected_merchant_name === merchantName,
          payment: { tx_signature: q.tx_hash ?? "", network: "mock" },
        };
      }),
  );
  return server;
}
