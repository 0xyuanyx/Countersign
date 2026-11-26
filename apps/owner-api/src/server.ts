import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { explorerUrl } from "@countersign/hsp";
import {
  AgentRegistry,
  ApprovalStore,
  FileSpendLedger,
  PolicyFile,
  SeenStore,
  formatAmount,
  HistoryStore,
  TaskStore,
  parseAmount,
  readPause,
  summarizePolicy,
  writePause,
  type AgentInfo,
  type Connection,
  type HistoryEntry,
  type StatePaths,
} from "@countersign/wallet-core";
import { z } from "zod";
import { loadCatalog, type CatalogSource } from "./catalog.js";

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
  /**
   * 에이전트별 기능 (11/26): signer에게 계정 주소·출금을 묻고, RPC로 실잔액을 읽는다.
   * 없으면 에이전트별 주소·잔액·출금 경로는 503.
   */
  agentOps?: {
    address: (agentId: string) => Promise<string | undefined>;
    usdcBalance: (chainId: number, token: `0x${string}`, owner: `0x${string}`) => Promise<bigint>;
    nativeBalance: (chainId: number, owner: `0x${string}`) => Promise<bigint>;
    /** amount: 최소 단위, 없으면 전액. 받는 곳은 주인 0번 계정 고정 */
    withdraw: (
      agentId: string,
      amount: bigint | undefined,
    ) => Promise<
      | { ok: true; tx_hash: string; from: string; to: string; amount: string; chain_id: number; token: string }
      | { ok: false; code: string; reason: string; next_action?: string }
    >;
  };
  /** 맡기기 추천 칩용 판매자 목록 (없으면 GET /api/catalog는 빈 목록) */
  catalogSellers?: CatalogSource[];
  /** 새 에이전트 정책의 기본값 (2번 이상 계정). 없으면 1번 정책을 복사 */
  newAgentPolicy?: { perTxMax: string; dailyMax: string; chains: number[]; sellers: Record<string, string> };
}

const PauseBodySchema = z.object({ reason: z.string().max(200).optional() }).strict();
const MAX_BODY = 4096;

export function createOwnerApi(d: OwnerApiDeps): Server {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const origins = new Set(d.allowedOrigins ?? []);

  const approvals = new ApprovalStore(d.paths.approvals);
  const tasks = new TaskStore(d.paths.tasks);
  const registry = new AgentRegistry(d.paths, d.policy.path);
  const connections = registry.connections;
  const seen = new SeenStore(d.paths.seen);
  const policyFiles = new Map<string, PolicyFile>([[d.policy.path, d.policy]]);
  const policyOf = (info: AgentInfo) => {
    let p = policyFiles.get(info.policyPath);
    if (!p) policyFiles.set(info.policyPath, (p = new PolicyFile(info.policyPath)));
    return p;
  };
  const addressCache = new Map<string, string>();
  async function addressOf(agentId: string): Promise<string | undefined> {
    const hit = addressCache.get(agentId);
    if (hit) return hit;
    const a = await d.agentOps?.address(agentId).catch(() => undefined);
    if (a) addressCache.set(agentId, a);
    return a;
  }

  /** ?agent=<id> (또는 /api/agents/:id/...) → 그 에이전트. 없으면 첫 에이전트(1번 계정, 기존 전역 경로) */
  function scope(agentId: string | null | undefined): AgentInfo | undefined {
    return registry.resolve(agentId ?? undefined);
  }
  /** 이 에이전트의 내역인지: 연결 id가 같거나, 1번 계정이면 연결 id 없는 옛 항목·로컬 항목도 포함 */
  function belongs(e: HistoryEntry, info: AgentInfo): boolean {
    if (e.agent_id === info.id) return true;
    if (info.accountIndex !== 1) return false;
    if (!e.agent_id || e.agent_id === "local") return true;
    const other = connections.get(e.agent_id);
    return !!other && AgentRegistry.indexOf(other) === 1 && info.id === "local";
  }
  function historyFor(info: AgentInfo | undefined, limit: number) {
    const all = new HistoryStore(d.paths.history).list(info ? 2000 : limit);
    return (info ? all.filter((e) => belongs(e, info)) : all).slice(0, limit);
  }
  async function summaryFor(info: AgentInfo) {
    const ledger = new FileSpendLedger(info.signerLedger);
    const account = info.id === "local" ? await d.account?.().catch(() => undefined) : await addressOf(info.id);
    return { ...summarizePolicy(policyOf(info).get(), ledger, readPause(d.paths.pause), now(), account), agent_id: info.id };
  }
  async function balanceFor(info: AgentInfo) {
    const policy = policyOf(info).get();
    const chainId = [...policy.chains][0]!;
    const token = policy.tokens.get(chainId)!;
    const address = info.id === "local" ? await d.account?.().catch(() => undefined) : await addressOf(info.id);
    if (!d.agentOps || !address) return { agent_id: info.id, chain_id: chainId, token, error: "signer가 꺼져 있어 주소를 모름" };
    try {
      const [usdc, native] = await Promise.all([
        d.agentOps.usdcBalance(chainId, token, address as `0x${string}`),
        d.agentOps.nativeBalance(chainId, address as `0x${string}`),
      ]);
      return {
        agent_id: info.id,
        address,
        chain_id: chainId,
        token,
        token_symbol: "USDC",
        usdc: formatAmount(usdc),
        /** 가스용 기본 토큰 (Sepolia는 ETH). 에이전트 결제는 HSP가 가스를 대신 내서 0이어도 된다 */
        native: formatAmount(native, 18),
        explorer_url: explorerUrl(chainId, "address", address),
      };
    } catch {
      return { agent_id: info.id, address, chain_id: chainId, token, error: "RPC 조회 실패" };
    }
  }
  async function agentView(c: Connection) {
    const info = registry.resolve(c.id)!;
    const s = seen.get(c.id);
    const { token_sha256: _h, ...pub } = c;
    const last = historyFor(info, 1)[0]?.at;
    const chainId = (() => {
      try {
        return [...policyOf(info).get().chains][0];
      } catch {
        return undefined;
      }
    })();
    const address = await addressOf(c.id);
    return {
      ...pub,
      account_index: info.accountIndex,
      ...(address && { address }),
      ...(chainId && { chain_id: chainId }),
      /** 주인이 끊지 않았는지 */
      active: !c.disconnected_at,
      /** 실제로 붙었는지: 끊기지 않았고, 그 토큰으로 MCP에 한 번이라도 붙음 */
      connected: !c.disconnected_at && !!(s.attached_at ?? s.last_seen_at),
      paused: !!c.paused_at,
      hidden: !!c.hidden_at,
      ...(s.attached_at && { attached_at: s.attached_at }),
      ...(s.last_seen_at && { last_seen_at: s.last_seen_at }),
      ...(last && { last_activity_at: last }),
    };
  }
  function deposit(info: AgentInfo, address: string | undefined) {
    const policy = policyOf(info).get();
    const chainId = [...policy.chains][0]!;
    return {
      ...(address && { address }),
      chain_id: chainId,
      token: policy.tokens.get(chainId)!,
      token_symbol: "USDC",
      ...(address && { explorer_url: explorerUrl(chainId, "address", address) }),
    };
  }
  async function patchPolicy(req: IncomingMessage, res: ServerResponse, info: AgentInfo) {
    if (!authorized(req, d.ownerToken)) return send(res, 401, { ok: false, error: "주인 토큰이 필요함" });
    const body = await readJson(req);
    try {
      policyOf(info).update(body);
    } catch (e) {
      const detail =
        e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join(".") || "(본문)"}: ${i.message}`).join("; ")
          : e instanceof Error
            ? e.message
            : "형식 오류";
      return send(res, 400, { ok: false, error: `정책을 바꾸지 않음: ${detail}`.slice(0, 500) });
    }
    return send(res, 200, await summaryFor(info));
  }
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
      const agentId = url.searchParams.get("agentId") ?? url.searchParams.get("agent");
      const list = approvals.list(st).map((r) => ({ ...r, agent_id: r.agent_id ?? "local" }));
      return send(res, 200, { requests: agentId ? list.filter((r) => r.agent_id === agentId) : list });
    }
    if ((m = /^POST \/api\/requests\/([a-z0-9_]+)\/(approve|reject)$/.exec(route))) {
      const body = RequestDecisionSchema.safeParse(await readJson(req));
      if (!body.success) return send(res, 400, { ok: false, error: "본문 형식: { remember?: boolean }" });
      const r = approvals.get(m[1]!);
      if (!r) return send(res, 404, { ok: false, error: "없는 요청" });
      if (r.status !== "pending") return send(res, 409, { ok: false, error: `이미 결정됨 (${r.status})` });
      const approve = m[2] === "approve";
      if (approve && r.order_expires_at <= now()) return send(res, 410, { ok: false, error: "주문이 이미 만료됨" });
      if (approve && r.task_id) {
        const t = tasks.get(r.task_id);
        if (!t || t.status === "paused" || t.status === "cancelled") {
          return send(res, 409, { ok: false, error: `맡긴 일이 ${t?.status === "paused" ? "멈춘" : "취소된"} 상태라 승인할 수 없음` });
        }
      }
      if (approve && body.data.remember) {
        // "다음부터 묻지 않기": 판매자 이름 → 이 주문의 받는 주소로 정책에 등록. 같은 이름이 다른 주소로 있으면 거부
        // 요청한 에이전트의 정책에 넣는다 (에이전트마다 판매자 목록이 따로다)
        const info = scope(r.agent_id) ?? scope(undefined)!;
        const pf = policyOf(info);
        const cur = pf.json();
        const existing = cur.sellers[r.seller];
        if (existing && existing.toLowerCase() !== r.pay_to.toLowerCase()) {
          return send(res, 409, { ok: false, error: `"${r.seller}"은 이미 다른 주소로 등록됨` });
        }
        try {
          pf.update({ sellers: { ...cur.sellers, [r.seller]: r.pay_to } });
        } catch {
          return send(res, 400, { ok: false, error: "판매자 이름을 정책에 넣을 수 없음 (1~64자)" });
        }
      }
      return send(res, 200, approvals.decide(r.id, approve, now(), approve && body.data.remember === true));
    }

    // ── 맡기기 ──
    if (route === "GET /api/tasks") {
      const agentId = url.searchParams.get("agentId") ?? url.searchParams.get("agent");
      const list = tasks.list();
      return send(res, 200, { tasks: agentId ? list.filter((t) => t.agent_id === agentId) : list });
    }
    if (route === "POST /api/tasks") {
      const body = TaskBodySchema.safeParse(await readJson(req));
      if (!body.success) return send(res, 400, { ok: false, error: '본문 형식: { text: string, maxAmount: "0.50" }' });
      const max = parseAmount(body.data.maxAmount);
      if (max === 0n) return send(res, 400, { ok: false, error: "maxAmount는 0보다 커야 함" });
      if (body.data.agentId && !connections.get(body.data.agentId)) return send(res, 404, { ok: false, error: "없는 에이전트" });
      return send(res, 201, tasks.create(body.data.text, max, now(), body.data.agentId));
    }
    if ((m = /^POST \/api\/tasks\/([a-z0-9_]+)\/(pause|resume|cancel)$/.exec(route))) {
      const t = tasks.get(m[1]!);
      if (!t) return send(res, 404, { ok: false, error: "없는 일" });
      if (m[2] === "pause") {
        const r = tasks.pause(t.id, now());
        if (r === "invalid") return send(res, 409, { ok: false, error: `멈출 수 없는 상태 (${t.status})` });
        return send(res, 200, r);
      }
      if (m[2] === "resume") {
        const r = tasks.resume(t.id, now());
        if (r === "invalid") return send(res, 409, { ok: false, error: `멈춘 일이 아님 (${t.status})` });
        return send(res, 200, r);
      }
      if (t.status === "cancelled") return send(res, 200, t);
      // 취소: 이 일에서 생긴 대기 중 구매 요청도 같이 거절한다
      for (const r of approvals.list("pending")) if (r.task_id === t.id) approvals.decide(r.id, false, now());
      return send(res, 200, tasks.update(t.id, { status: "cancelled" }, now()));
    }

    // ── 에이전트 연결 (원격 MCP 주소·토큰) ──
    if (route === "GET /api/agents") {
      return send(res, 200, { agents: await Promise.all(connections.list().map(agentView)) });
    }
    if (route === "POST /api/agents") {
      const body = AgentBodySchema.safeParse(await readJson(req));
      if (!body.success) return send(res, 400, { ok: false, error: "본문 형식: { name: 영문·숫자·-·_ 1~40자 }" });
      if (connections.list().some((c) => c.name === body.data.name && !c.disconnected_at)) {
        return send(res, 409, { ok: false, error: "같은 이름의 연결이 이미 있음" });
      }
      const { connection, token, info } = registry.create(body.data.name, now());
      if (info.accountIndex !== 1 && d.newAgentPolicy) {
        // 새 에이전트 기본 정책 (앱 요청: 1회 0.5, 하루 5, 판매자 없음, Ethereum Sepolia)
        policyOf(info).update(d.newAgentPolicy);
      }
      const view = await agentView(connection);
      return send(res, 201, {
        ...view,
        token,
        connect: connectCommands(mcpBase, connection.name, token),
        deposit: deposit(info, view.address),
      });
    }
    if ((m = /^PATCH \/api\/agents\/([a-z0-9_]+)$/.exec(route))) {
      if (!authorized(req, d.ownerToken)) return send(res, 401, { ok: false, error: "주인 토큰이 필요함" });
      const body = AgentPatchSchema.safeParse(await readJson(req));
      if (!body.success) return send(res, 400, { ok: false, error: "본문 형식: { name?: 영문·숫자·-·_ 1~40자, hidden?: boolean }" });
      const id = m[1]!;
      const cur = connections.get(id);
      if (!cur) return send(res, 404, { ok: false, error: "없는 연결" });
      if (body.data.hidden === true && !cur.hidden_at) {
        // 숨기기: 연결이 끊겼고 그 계정 USDC가 0일 때만 (돈이 남은 에이전트를 실수로 안 보이게 하지 않게)
        if (!cur.disconnected_at) return send(res, 400, { ok: false, error: "연결을 먼저 끊어야 숨길 수 있음" });
        const info = registry.resolve(id)!;
        const bal = await balanceFor(info);
        if (!("usdc" in bal)) return send(res, 400, { ok: false, error: `잔액을 확인할 수 없어 숨기지 않음 (${bal.error})` });
        if (bal.usdc !== "0") {
          const shared = info.accountIndex === 1 ? " (1번 계정은 첫 에이전트와 같이 쓰는 계정)" : "";
          return send(res, 400, { ok: false, error: `USDC 잔액이 ${bal.usdc} 남아 있어 숨길 수 없음. 먼저 출금하세요${shared}` });
        }
      }
      if (body.data.name !== undefined) {
        const r = connections.rename(id, body.data.name);
        if (r === "duplicate") return send(res, 409, { ok: false, error: "같은 이름의 연결이 이미 있음" });
      }
      if (body.data.hidden !== undefined) connections.setHidden(id, body.data.hidden, now());
      return send(res, 200, await agentView(connections.get(id)!));
    }
    if ((m = /^POST \/api\/agents\/([a-z0-9_]+)\/(pause|resume)$/.exec(route))) {
      const c = connections.setPaused(m[1]!, m[2] === "pause", now());
      if (!c) return send(res, 404, { ok: false, error: "없는 연결" });
      return send(res, 200, publicAgent(c));
    }
    if ((m = /^(GET|PATCH|POST) \/api\/agents\/([a-z0-9_]+)\/(policy|policy\/file|balance|history|withdraw)$/.exec(route))) {
      const c = connections.get(m[2]!);
      const info = c && registry.resolve(c.id);
      if (!c || !info) return send(res, 404, { ok: false, error: "없는 연결" });
      const op = `${m[1]} ${m[3]}`;
      if (op === "GET policy") return send(res, 200, await summaryFor(info));
      if (op === "GET policy/file") return send(res, 200, policyOf(info).json());
      if (op === "PATCH policy") return patchPolicy(req, res, info);
      if (op === "GET balance") return send(res, 200, await balanceFor(info));
      if (op === "GET history") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 200);
        return send(res, 200, { entries: historyFor(info, limit) });
      }
      if (op === "POST withdraw") return withdraw(req, res, info);
      return send(res, 405, { ok: false, error: "지원하지 않는 메서드" });
    }
    if ((m = /^GET \/api\/agents\/([a-z0-9_]+)$/.exec(route))) {
      const c = connections.get(m[1]!);
      const info = c && registry.resolve(c.id);
      if (!c || !info) return send(res, 404, { ok: false, error: "없는 연결" });
      const agent = await agentView(c);
      return send(res, 200, {
        agent,
        policy: await summaryFor(info),
        balance: await balanceFor(info),
        deposit: deposit(info, agent.address),
      });
    }
    if ((m = /^POST \/api\/agents\/([a-z0-9_]+)\/disconnect$/.exec(route))) {
      const c = connections.disconnect(m[1]!, now());
      if (!c) return send(res, 404, { ok: false, error: "없는 연결" });
      const { token_sha256: _h, ...pub } = c;
      return send(res, 200, pub);
    }
    return send(res, 404, { ok: false, error: "없는 경로" });
  }

  /** 출금: 한도·정지와 상관없이, 받는 곳은 주인 0번 계정 고정. 실제 체인 거래라 내역에 kind:"withdraw"로 남긴다 */
  async function withdraw(req: IncomingMessage, res: ServerResponse, info: AgentInfo) {
    if (!authorized(req, d.ownerToken)) return send(res, 401, { ok: false, error: "주인 토큰이 필요함" });
    if (!d.agentOps) return send(res, 503, { ok: false, error: "출금 기능이 꺼져 있음 (signer 연결 없음)" });
    const body = WithdrawBodySchema.safeParse(await readJson(req));
    if (!body.success) return send(res, 400, { ok: false, error: '본문 형식: { amount?: "1.5" } (빼면 전액)' });
    const amount = body.data.amount === undefined ? undefined : parseAmount(body.data.amount);
    if (amount === 0n) return send(res, 400, { ok: false, error: "amount는 0보다 커야 함" });
    const r = await d.agentOps.withdraw(info.id, amount);
    const history = new HistoryStore(d.paths.history);
    const base = { id: `wd_${Date.now().toString(36)}`, at: now(), order_ref: "withdraw", kind: "withdraw" as const, agent_id: info.id };
    if (!r.ok) {
      history.append({ ...base, status: "failed", code: r.code, reason: r.reason });
      return send(res, 502, { ok: false, error: r.reason, code: r.code });
    }
    const out = {
      ok: true as const,
      tx_hash: r.tx_hash,
      explorer_url: explorerUrl(r.chain_id, "tx", r.tx_hash),
      amount: formatAmount(BigInt(r.amount)),
      from: r.from,
      to: r.to,
      chain_id: r.chain_id,
      token: r.token,
    };
    history.append({
      ...base,
      status: "paid",
      amount: out.amount,
      from: r.from,
      pay_to: r.to,
      chain_id: r.chain_id,
      tx_hash: r.tx_hash,
      ...(out.explorer_url && { explorer_url: out.explorer_url }),
      purpose: "주인 계정으로 출금",
    });
    return send(res, 200, out);
  }

  async function summary(agentId?: string | null) {
    const info = scope(agentId);
    if (!info) return undefined;
    return summaryFor(info);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      // ngrok-skip-browser-warning: ngrok 무료 주소로 열 때 앱이 붙이는 헤더 (경고 페이지 건너뛰기)
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ngrok-skip-browser-warning");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    }
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (d.requireTokenAll && !authorized(req, d.ownerToken)) return send(res, 401, { ok: false, error: "주인 토큰이 필요함" });

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;
    const agentParam = url.searchParams.get("agent") ?? url.searchParams.get("agentId");
    switch (route) {
      case "GET /api/policy": {
        const sum = await summary(agentParam);
        return sum ? send(res, 200, sum) : send(res, 404, { ok: false, error: "없는 에이전트" });
      }
      case "GET /api/policy/file": {
        const info = scope(agentParam);
        return info ? send(res, 200, policyOf(info).json()) : send(res, 404, { ok: false, error: "없는 에이전트" });
      }
      case "PATCH /api/policy": {
        const info = scope(agentParam);
        return info ? patchPolicy(req, res, info) : send(res, 404, { ok: false, error: "없는 에이전트" });
      }
      case "GET /api/history": {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 200);
        if (!agentParam) return send(res, 200, { entries: historyFor(undefined, limit) });
        const info = scope(agentParam);
        return info ? send(res, 200, { entries: historyFor(info, limit) }) : send(res, 404, { ok: false, error: "없는 에이전트" });
      }
      case "GET /api/balance": {
        if (agentParam) {
          const info = scope(agentParam);
          return info ? send(res, 200, await balanceFor(info)) : send(res, 404, { ok: false, error: "없는 에이전트" });
        }
        if (!d.balances) return send(res, 503, { ok: false, error: "잔액 조회기가 없음" });
        return send(res, 200, await d.balances());
      }
      case "GET /api/catalog": {
        const info = agentParam ? scope(agentParam) : undefined;
        if (agentParam && !info) return send(res, 404, { ok: false, error: "없는 에이전트" });
        let policy;
        try {
          policy = info ? policyOf(info).get() : undefined;
        } catch {
          policy = undefined;
        }
        return send(res, 200, await loadCatalog(d.catalogSellers ?? [], policy));
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
        return routeOwnerState(req, res, url, route);
    }
  }
}

function publicAgent(c: Connection) {
  const { token_sha256: _h, ...pub } = c;
  return { ...pub, connected: !c.disconnected_at, paused: !!c.paused_at, hidden: !!c.hidden_at };
}

const RequestDecisionSchema = z.object({ remember: z.boolean().optional() }).strict();
const TaskBodySchema = z
  .object({
    text: z.string().min(1).max(2000),
    maxAmount: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/),
    /** 이 일을 맡길 에이전트 연결 id (없으면 아무 에이전트나) */
    agentId: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
  })
  .strict();
const WithdrawBodySchema = z.object({ amount: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).optional() }).strict();
const AgentBodySchema = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict();
const AgentPatchSchema = z
  .object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(), hidden: z.boolean().optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.hidden !== undefined, "name 또는 hidden 필요");

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
