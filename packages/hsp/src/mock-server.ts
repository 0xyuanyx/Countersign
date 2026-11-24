import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MockHsp, type MockHspOptions } from "./mock.js";
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

export async function serveMockHsp(opts: MockHspOptions & { port?: number }): Promise<MockHspServer> {
  const hsp = new MockHsp(opts);

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
    const server = buildServer(hsp);
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

function buildServer(hsp: MockHsp): McpServer {
  const server = new McpServer({ name: "hsp-mock", version: "0.0.0" });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }] };
    } catch (e) {
      const text =
        e instanceof HspError ? `${e.hspCode ?? "ERROR"} ${e.message}` : "INTERNAL mock 처리 중 오류";
      return { isError: true, content: [{ type: "text" as const, text }] };
    }
  };
  const orderRef = { order_ref: z.string().min(1).max(200) };
  const paymentId = { payment_id: z.string().min(1).max(200) };

  server.registerTool("get_chain_config", { description: "지원 체인·토큰" }, () => run(() => hsp.getChainConfig()));
  server.registerTool(
    "create_order",
    {
      description: "판매자 주문 생성",
      inputSchema: {
        pay_to: z.string(),
        amount: z.string(),
        chain_id: z.number().int(),
        token: z.string(),
        description: z.string().max(2000).optional(),
        ttl_seconds: z.number().int().positive().optional(),
      },
    },
    (a) => run(() => hsp.createOrder(a)),
  );
  server.registerTool("get_order", { description: "주문 조회", inputSchema: orderRef }, (a) =>
    run(() => hsp.getOrder(a.order_ref)),
  );
  server.registerTool(
    "prepare_payment",
    { description: "EIP-3009 서명 대상 만들기", inputSchema: { ...orderRef, payer: z.string() } },
    (a) => run(() => hsp.preparePayment(a.order_ref, a.payer)),
  );
  server.registerTool(
    "finalize_payment",
    {
      description: "서명 제출",
      inputSchema: { ...orderRef, signature: z.string(), payment_payload: z.unknown().optional() },
    },
    (a) => run(() => hsp.finalizePayment(a.order_ref, a.signature)),
  );
  server.registerTool("estimate_fee", { description: "수수료 추정", inputSchema: orderRef }, (a) =>
    run(() => hsp.estimateFee(a.order_ref)),
  );
  server.registerTool("submit_payment", { description: "relayer 제출", inputSchema: paymentId }, (a) =>
    run(() => hsp.submitPayment(a.payment_id)),
  );
  server.registerTool("query_payment", { description: "결제 상태", inputSchema: paymentId }, (a) =>
    run(() => hsp.queryPayment(a.payment_id)),
  );
  return server;
}
