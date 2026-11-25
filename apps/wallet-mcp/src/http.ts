import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectionStore } from "@countersign/wallet-core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { WalletService } from "./service.js";
import { buildMcpServer } from "./setup.js";

/**
 * 원격 지갑 MCP (Streamable HTTP, 상태 없음). 폰 앱이 만든 "에이전트 연결"마다 주소·토큰이 하나씩 있다.
 *   POST /mcp/<토큰>                      Claude 커스텀 커넥터처럼 헤더를 못 넣는 앱용 (주소 자체가 비밀)
 *   POST /mcp  + Authorization: Bearer <토큰>   Codex --bearer-token-env-var, Claude Code --header
 * 토큰이 없거나, 끊긴 연결이면 401. 키는 여기 없다: 서명은 같은 기계의 signer 소켓에 부탁한다.
 * HTTPS는 앞단(리버스 프록시·터널)에서 끝낸다. 이 서버는 기본 127.0.0.1에만 연다.
 */
export function createWalletHttp(wallet: WalletService, connections: ConnectionStore): Server {
  return createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });
    const m = /^\/mcp(?:\/([A-Za-z0-9_-]+))?\/?$/.exec(path);
    if (!m) return json(res, 404, { error: "not found" });
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    const conn = connections.authenticate(m[1] ?? bearer ?? "");
    if (!conn) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="countersign"');
      return json(res, 401, { error: "unknown or disconnected agent token" });
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const server = buildMcpServer(wallet, {
      name: conn.name,
      id: conn.id,
      // 결제할 때마다 다시 읽는다: 앱에서 멈추면 열려 있던 연결도 바로 막힌다
      paused: () => !!connections.get(conn.id)?.paused_at,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

export async function listenWalletHttp(server: Server, port: number, host = "127.0.0.1"): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return `http://${host}:${(server.address() as AddressInfo).port}`;
}
