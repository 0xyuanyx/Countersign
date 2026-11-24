import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  FileSpendLedger,
  HistoryStore,
  readPause,
  summarizePolicy,
  writePause,
  type Policy,
  type StatePaths,
} from "@countersign/wallet-core";
import { z } from "zod";

/**
 * 주인(사람)용 로컬 HTTP API. PWA 앱이 정책·내역을 보고 결제를 정지·재개한다.
 * 에이전트용 MCP와 분리된 별도 프로세스다 (AGENTS.md 규칙 4: 정책을 바꾸는 기능은 MCP에 열지 않는다).
 *
 * - 127.0.0.1에만 연다.
 * - 읽기(GET)와 정지(POST /api/pause)는 토큰 없이 된다. 정지는 "안전한 방향"이라 누구든 누를 수 있게 둔다.
 * - 재개(POST /api/resume)만 주인 토큰(Authorization: Bearer ...)이 필요하다. 에이전트가 스스로 정지를 풀 수 없게.
 * - 정책 값(한도·판매자) 변경 API는 아직 없다. 정책 파일은 주인이 직접 고친다 (signer 재시작 필요).
 *
 * 엔드포인트 (응답은 모두 JSON):
 *   GET  /api/policy           정책 요약 + 최근 24시간 사용액 + 정지 여부
 *   GET  /api/history?limit=20 결제·거부 내역 (최신순)
 *   GET  /api/pause            정지 상태
 *   POST /api/pause  {reason?} 결제 정지 (지갑 MCP와 signer가 다음 결제부터 거부)
 *   POST /api/resume           결제 재개 (토큰 필요)
 */
export interface OwnerApiDeps {
  policy: Policy;
  paths: StatePaths;
  ownerToken: string;
  /** 에이전트 계정 주소 (signer에게 묻는다. 못 얻으면 undefined) */
  account?: () => Promise<string | undefined>;
  allowedOrigins?: string[];
  now?: () => number;
}

const PauseBodySchema = z.object({ reason: z.string().max(200).optional() }).strict();
const MAX_BODY = 4096;

export function createOwnerApi(d: OwnerApiDeps): Server {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const origins = new Set(d.allowedOrigins ?? []);

  return createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, { ok: false, error: "처리 중 오류" }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/policy": {
        const ledger = new FileSpendLedger(d.paths.signerLedger);
        const account = await d.account?.().catch(() => undefined);
        return send(res, 200, summarizePolicy(d.policy, ledger, readPause(d.paths.pause), now(), account));
      }
      case "GET /api/history": {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 200);
        return send(res, 200, { entries: new HistoryStore(d.paths.history).list(limit) });
      }
      case "GET /api/pause":
        return send(res, 200, readPause(d.paths.pause));
      case "POST /api/pause": {
        const body = PauseBodySchema.safeParse(await readJson(req));
        if (!body.success) return send(res, 400, { ok: false, error: "본문 형식: { reason?: string }" });
        const state = { paused: true, at: now(), ...(body.data.reason && { reason: body.data.reason }) };
        writePause(d.paths.pause, state);
        return send(res, 200, state);
      }
      case "POST /api/resume": {
        if (!authorized(req, d.ownerToken)) return send(res, 401, { ok: false, error: "주인 토큰이 필요함" });
        const state = { paused: false, at: now() };
        writePause(d.paths.pause, state);
        return send(res, 200, state);
      }
      default:
        return send(res, 404, { ok: false, error: "없는 경로" });
    }
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer (\S+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function listenOwnerApi(server: Server, port: number): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
