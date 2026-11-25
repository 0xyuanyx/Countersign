import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ApprovalStore,
  ConnectionStore,
  FileSpendLedger,
  HistoryStore,
  TaskStore,
  parseAmount,
  readPause,
  summarizePolicy,
  writePause,
  type PolicyFile,
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
 * - 정책 값(한도·판매자·체인) 변경(PATCH /api/policy)도 주인 토큰이 필요하다. 지갑 MCP와 signer는 다음 결제부터
 *   바뀐 파일을 다시 읽는다 (재시작 불필요). 서명 계정(agent·accountIndex)은 바꿀 수 없다.
 *
 * 엔드포인트 (응답은 모두 JSON):
 *   GET  /api/policy           정책 요약 + 최근 24시간 사용액 + 정지 여부
 *   GET  /api/policy/file      정책 파일 원본 (편집 화면용)
 *   PATCH /api/policy          {perTxMax?, dailyMax?, sellers?, chains?, tokenAddresses?, maxAuthorizationSeconds?} (토큰 필요)
 *   GET  /api/history?limit=20 결제·거부 내역 (최신순)
 *   GET  /api/balance          에이전트 계정 주소와 체인별 USDC 잔액 (입금 화면)
 *   GET  /api/pause            정지 상태
 *   POST /api/pause  {reason?} 결제 정지 (지갑 MCP와 signer가 다음 결제부터 거부)
 *   POST /api/resume           결제 재개 (토큰 필요)
 */
export interface OwnerApiDeps {
  /** 정책 파일 (읽기: 요청마다 다시 읽음, 쓰기: PATCH /api/policy) */
  policy: PolicyFile;
  paths: StatePaths;
  ownerToken: string;
  /** 에이전트 계정 주소 (signer에게 묻는다. 못 얻으면 undefined) */
  account?: () => Promise<string | undefined>;
  allowedOrigins?: string[];
  /**
   * 터널로 인터넷에 열 때 true: 읽기와 긴급 정지를 포함한 모든 요청에 주인 토큰을 요구한다.
   * (127.0.0.1에서만 쓸 때는 읽기·정지를 토큰 없이 둔다. CORS는 브라우저만 막고 curl은 못 막기 때문)
   */
  requireTokenAll?: boolean;
  now?: () => number;
  /** 에이전트 계정의 체인별 USDC 잔액 (사람이 읽는 문자열). 홈 화면·입금 화면용 */
  /** 에이전트 연결 주소의 공개 기준 주소 (예: 터널 https://xxx.trycloudflare.com). 기본 http://127.0.0.1:7440 */
  publicMcpUrl?: string;
  balances?: () => Promise<{ account?: string; balances: { chain_id: number; balance?: string; error?: string }[] }>;
}

const PauseBodySchema = z.object({ reason: z.string().max(200).optional() }).strict();
const MAX_BODY = 4096;

export function createOwnerApi(d: OwnerApiDeps): Server {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const origins = new Set(d.allowedOrigins ?? []);

  const approvals = new ApprovalStore(d.paths.approvals);
  const tasks = new TaskStore(d.paths.tasks);
  const connections = new ConnectionStore(d.paths.connections);
  const mcpBase = (d.publicMcpUrl ?? "http://127.0.0.1:7440").replace(/\/+$/, "");

  return createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, { ok: false, error: "처리 중 오류" }));
  });

  /** 구매 요청·맡기기·에이전트 연결 (쓰기는 모두 주인 토큰) */
  async function routeOwnerState(req: IncomingMessage, res: ServerResponse, url: URL, route: string): Promise<void> {
    const needAuth = req.method === "POST";
    if (needAuth && /^POST \/api\/(requests|tasks|agents)/.test(route) && !authorized(req, d.ownerToken)) {
      return send(res, 401, { ok: false, error: "주인 토큰이 필요함" });
    }
    let m: RegExpExecArray | null;

    // ── 구매 요청 ──
    if (route === "GET /api/requests") {
      const status = url.searchParams.get("status");
      const st = status === "pending" || status === "approved" || status === "rejected" ? status : undefined;
      return send(res, 200, { requests: approvals.list(st) });
    }
    if ((m = /^POST \/api\/requests\/([a-z0-9_]+)\/(approve|reject)$/.exec(route))) {
      const body = RequestDecisionSchema.safeParse(await readJson(req));
      if (!body.success) return send(res, 400, { ok: false, error: "본문 형식: { remember?: boolean }" });
      const r = approvals.get(m[1]!);
      if (!r) return send(res, 404, { ok: false, error: "없는 요청" });
      if (r.status !== "pending") return send(res, 409, { ok: false, error: `이미 결정됨 (${r.status})` });
      const approve = m[2] === "approve";
      if (approve && r.order_expires_at <= now()) return send(res, 410, { ok: false, error: "주문이 이미 만료됨" });
      if (approve && body.data.remember) {
        // "다음부터 묻지 않기": 판매자 이름 → 이 주문의 받는 주소로 정책에 등록. 같은 이름이 다른 주소로 있으면 거부
        const cur = d.policy.json();
        const existing = cur.sellers[r.seller];
        if (existing && existing.toLowerCase() !== r.pay_to.toLowerCase()) {
          return send(res, 409, { ok: false, error: `"${r.seller}"은 이미 다른 주소로 등록됨` });
        }
        try {
          d.policy.update({ sellers: { ...cur.sellers, [r.seller]: r.pay_to } });
        } catch {
          return send(res, 400, { ok: false, error: "판매자 이름을 정책에 넣을 수 없음 (1~64자)" });
        }
      }
      return send(res, 200, approvals.decide(r.id, approve, now(), approve && body.data.remember === true));
    }

    // ── 맡기기 ──
    if (route === "GET /api/tasks") return send(res, 200, { tasks: tasks.list() });
    if (route === "POST /api/tasks") {
      const body = TaskBodySchema.safeParse(await readJson(req));
      if (!body.success) return send(res, 400, { ok: false, error: '본문 형식: { text: string, maxAmount: "0.50" }' });
      const max = parseAmount(body.data.maxAmount);
      if (max === 0n) return send(res, 400, { ok: false, error: "maxAmount는 0보다 커야 함" });
      return send(res, 201, tasks.create(body.data.text, max, now()));
    }
    if ((m = /^POST \/api\/tasks\/([a-z0-9_]+)\/cancel$/.exec(route))) {
      const t = tasks.get(m[1]!);
      if (!t) return send(res, 404, { ok: false, error: "없는 일" });
      return send(res, 200, tasks.update(t.id, { status: "cancelled" }, now()));
    }

    // ── 에이전트 연결 (원격 MCP 주소·토큰) ──
    if (route === "GET /api/agents") {
      const hist = new HistoryStore(d.paths.history).list(500);
      return send(res, 200, {
        agents: connections.list().map(({ token_sha256: _h, ...c }) => ({
          ...c,
          connected: !c.disconnected_at,
          paused: !!c.paused_at,
          last_activity_at: hist.find((e) => e.agent_id === c.id || (!e.agent_id && e.agent === c.name))?.at,
        })),
      });
    }
    if (route === "POST /api/agents") {
      const body = AgentBodySchema.safeParse(await readJson(req));
      if (!body.success) return send(res, 400, { ok: false, error: "본문 형식: { name: 영문·숫자·-·_ 1~40자 }" });
      if (connections.list().some((c) => c.name === body.data.name && !c.disconnected_at)) {
        return send(res, 409, { ok: false, error: "같은 이름의 연결이 이미 있음" });
      }
      const { connection, token } = connections.create(body.data.name, now());
      const { token_sha256: _h, ...pub } = connection;
      return send(res, 201, { ...pub, token, connect: connectCommands(mcpBase, connection.name, token) });
    }
    if ((m = /^PATCH \/api\/agents\/([a-z0-9_]+)$/.exec(route))) {
      if (!authorized(req, d.ownerToken)) return send(res, 401, { ok: false, error: "주인 토큰이 필요함" });
      const body = AgentBodySchema.safeParse(await readJson(req));
      if (!body.success) return send(res, 400, { ok: false, error: "본문 형식: { name: 영문·숫자·-·_ 1~40자 }" });
      const c = connections.rename(m[1]!, body.data.name);
      if (!c) return send(res, 404, { ok: false, error: "없는 연결" });
      if (c === "duplicate") return send(res, 409, { ok: false, error: "같은 이름의 연결이 이미 있음" });
      return send(res, 200, publicAgent(c));
    }
    if ((m = /^POST \/api\/agents\/([a-z0-9_]+)\/(pause|resume)$/.exec(route))) {
      const c = connections.setPaused(m[1]!, m[2] === "pause", now());
      if (!c) return send(res, 404, { ok: false, error: "없는 연결" });
      return send(res, 200, publicAgent(c));
    }
    if ((m = /^POST \/api\/agents\/([a-z0-9_]+)\/disconnect$/.exec(route))) {
      const c = connections.disconnect(m[1]!, now());
      if (!c) return send(res, 404, { ok: false, error: "없는 연결" });
      const { token_sha256: _h, ...pub } = c;
      return send(res, 200, pub);
    }
    return send(res, 404, { ok: false, error: "없는 경로" });
  }

  async function summary() {
    const ledger = new FileSpendLedger(d.paths.signerLedger);
    const account = await d.account?.().catch(() => undefined);
    return summarizePolicy(d.policy.get(), ledger, readPause(d.paths.pause), now(), account);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    }
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (d.requireTokenAll && !authorized(req, d.ownerToken)) return send(res, 401, { ok: false, error: "주인 토큰이 필요함" });

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/policy":
        return send(res, 200, await summary());
      case "GET /api/policy/file":
        return send(res, 200, d.policy.json());
      case "PATCH /api/policy": {
        if (!authorized(req, d.ownerToken)) return send(res, 401, { ok: false, error: "주인 토큰이 필요함" });
        const body = await readJson(req);
        try {
          d.policy.update(body);
        } catch (e) {
          const detail =
            e instanceof z.ZodError
              ? e.issues.map((i) => `${i.path.join(".") || "(본문)"}: ${i.message}`).join("; ")
              : e instanceof Error
                ? e.message
                : "형식 오류";
          return send(res, 400, { ok: false, error: `정책을 바꾸지 않음: ${detail}`.slice(0, 500) });
        }
        return send(res, 200, await summary());
      }
      case "GET /api/history": {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 200);
        return send(res, 200, { entries: new HistoryStore(d.paths.history).list(limit) });
      }
      case "GET /api/balance":
        if (!d.balances) return send(res, 503, { ok: false, error: "잔액 조회기가 없음" });
        return send(res, 200, await d.balances());
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
        return routeOwnerState(req, res, url, route);
    }
  }
}

function publicAgent(c: import("@countersign/wallet-core").Connection) {
  const { token_sha256: _h, ...pub } = c;
  return { ...pub, connected: !c.disconnected_at, paused: !!c.paused_at };
}

const RequestDecisionSchema = z.object({ remember: z.boolean().optional() }).strict();
const TaskBodySchema = z
  .object({ text: z.string().min(1).max(2000), maxAmount: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/) })
  .strict();
const AgentBodySchema = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict();

/**
 * 앱 "에이전트 연결" 화면이 보여 줄 명령. 토큰이 든 주소는 비밀번호와 같다 (앱에서 한 번만 보여 준다).
 * 형식 출처: design/README.md "원격 MCP + 폰 앱" 표 (각 앱 공식 문서 기준)
 */
export function connectCommands(base: string, name: string, token: string) {
  const url = `${base}/mcp/${token}`;
  const cursorConfig = Buffer.from(JSON.stringify({ url })).toString("base64");
  return {
    url,
    claude_connector: url,
    claude_code: `claude mcp add --transport http countersign-${name} ${url}`,
    codex: `codex mcp add countersign-${name} --url ${url}`,
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=countersign-${name}&config=${encodeURIComponent(cursorConfig)}`,
  };
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
