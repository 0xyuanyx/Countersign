import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatAmount, parseUint, uintToString } from "./amount.js";
import type { Order } from "./order.js";
import type { CheckExtras } from "./policy.js";

/**
 * 주인 결정 상태: 구매 승인 요청, 맡긴 일, 에이전트 연결.
 * 기록 하나가 파일 하나 (폴더 0700, 파일 0600, 원자적 교체) → 지갑 MCP와 주인 API가 같은 기록을 동시에 쓸 일이 거의 없다.
 * 결정(승인·맡기기·연결 만들기)은 주인 API만 쓴다. 에이전트용 MCP에는 결정을 바꾸는 도구가 없다 (AGENTS.md 규칙 4).
 */
class RecordDir<T> {
  constructor(
    private readonly dir: string,
    private readonly schema: z.ZodType<T>,
  ) {}

  get(id: string): T | undefined {
    if (!/^[a-z0-9_-]{1,64}$/.test(id)) return undefined;
    const path = join(this.dir, `${id}.json`);
    if (!existsSync(path)) return undefined;
    try {
      const p = this.schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      return p.success ? p.data : undefined;
    } catch {
      return undefined;
    }
  }

  put(id: string, value: T): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `${id}.json`);
    const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.schema.parse(value)), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  }

  list(): T[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.get(f.slice(0, -5)))
      .filter((v): v is T => v !== undefined);
  }
}

const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

// ─── 구매 승인 요청 (NEEDS_OWNER_APPROVAL) ────────────────────────────────────

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  order_ref: z.string(),
  created_at: z.number().int(),
  status: z.enum(["pending", "approved", "rejected"]),
  reason: z.enum(["unknown_seller", "every_payment"]),
  seller: z.string(),
  purpose: z.string(),
  /** 최소 단위 정수 문자열 */
  amount_raw: z.string(),
  /** 사람이 읽는 USDC ("0.1") */
  amount: z.string(),
  pay_to: z.string(),
  chain_id: z.number().int(),
  token: z.string(),
  order_expires_at: z.number().int(),
  task_id: z.string().optional(),
  agent: z.string().optional(),
  /** 요청한 에이전트 연결 id (승인 때 "다음부터 묻지 않기"는 이 에이전트 정책에 들어간다) */
  agent_id: z.string().optional(),
  decided_at: z.number().int().optional(),
  /** 승인할 때 "다음부터 묻지 않기"를 켰는지 (켰으면 정책 sellers에 등록됨) */
  remember: z.boolean().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export class ApprovalStore {
  private readonly rec: RecordDir<ApprovalRequest>;
  constructor(dir: string) {
    this.rec = new RecordDir(dir, ApprovalRequestSchema);
  }

  /** 주문 하나에 요청 하나 (같은 주문으로 다시 부르면 같은 요청) */
  /**
   * 요청 하나 = (주문, 에이전트). 같은 주문이라도 다른 에이전트(다른 결제 계정)의 승인은 따로다 (11/27 리뷰 P1-3).
   * agentId 없음 = 1번 로컬 에이전트("local").
   */
  static idFor(orderRef: string, agentId = "local"): string {
    return `req_${createHash("sha256").update(`${agentId}\n${orderRef}`).digest("hex").slice(0, 16)}`;
  }

  get(id: string) {
    return this.rec.get(id);
  }
  forOrder(orderRef: string, agentId = "local") {
    const r = this.rec.get(ApprovalStore.idFor(orderRef, agentId));
    // 저장된 에이전트가 다르면 (해시 충돌 등) 남의 요청으로 보지 않는다
    return r && (r.agent_id ?? "local") === agentId ? r : undefined;
  }
  /** 최신순 */
  list(status?: ApprovalRequest["status"]) {
    return this.rec
      .list()
      .filter((r) => !status || r.status === status)
      .sort((a, b) => b.created_at - a.created_at);
  }

  /** 대기 요청을 만들거나, 이미 있으면 그대로 돌려준다 */
  ensure(args: {
    order: Order;
    reason: ApprovalRequest["reason"];
    seller: string;
    purpose: string;
    taskId?: string;
    agent?: string;
    agentId?: string;
    now: number;
  }): ApprovalRequest {
    const agentId = args.agentId ?? "local";
    const existing = this.forOrder(args.order.orderRef, agentId);
    if (existing) return existing;
    const req: ApprovalRequest = {
      id: ApprovalStore.idFor(args.order.orderRef, agentId),
      order_ref: args.order.orderRef,
      created_at: args.now,
      status: "pending",
      reason: args.reason,
      seller: args.seller,
      purpose: args.purpose,
      amount_raw: uintToString(args.order.amount),
      amount: formatAmount(args.order.amount),
      pay_to: args.order.payTo,
      chain_id: args.order.chainId,
      token: args.order.token,
      order_expires_at: args.order.expiresAt,
      ...(args.taskId && { task_id: args.taskId }),
      ...(args.agent && { agent: args.agent }),
      agent_id: agentId,
    };
    this.rec.put(req.id, req);
    return req;
  }

  decide(id: string, approve: boolean, now: number, remember = false): ApprovalRequest | undefined {
    const r = this.rec.get(id);
    if (!r || r.status !== "pending") return undefined;
    const next: ApprovalRequest = { ...r, status: approve ? "approved" : "rejected", decided_at: now, ...(approve && { remember }) };
    this.rec.put(id, next);
    return next;
  }

  /** checkOrder에 넘길 승인 (승인된 요청만) */
  /** checkOrder에 넘길 승인: 그 에이전트가 요청해서 승인된 것만 */
  approvalFor(orderRef: string, agentId = "local"): CheckExtras["approval"] {
    const r = this.forOrder(orderRef, agentId);
    if (!r || r.status !== "approved") return undefined;
    return { orderRef: r.order_ref, payTo: r.pay_to, amount: parseUint(r.amount_raw), chainId: r.chain_id, token: r.token };
  }
}

// ─── 맡긴 일 ─────────────────────────────────────────────────────────────────

export const TaskSchema = z.object({
  id: z.string(),
  text: z.string().max(2000),
  /** 최소 단위 정수 문자열. 지갑이 이 일로 하는 결제의 상한으로 강제한다 */
  max_amount_raw: z.string(),
  max_amount: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  /** open: 대기 / working: 에이전트가 받아 감 / paid: 결제됨 / done·failed: 에이전트 보고 / paused: 주인이 멈춤 / cancelled: 주인이 그만둠 */
  status: z.enum(["open", "working", "paid", "done", "failed", "paused", "cancelled"]),
  /** 멈추기 전 상태 (다시 켜면 돌아간다) */
  paused_from: z.enum(["open", "working", "paid"]).optional(),
  agent: z.string().optional(),
  /** 주인이 이 일을 맡긴 에이전트 연결 id. 없으면 아무 에이전트나 받아 갈 수 있다 */
  agent_id: z.string().optional(),
  order_refs: z.array(z.string()),
  note: z.string().max(1000).optional(),
});
export type Task = z.infer<typeof TaskSchema>;
const ACTIVE: Task["status"][] = ["open", "working", "paid"];

export class TaskStore {
  private readonly rec: RecordDir<Task>;
  constructor(dir: string) {
    this.rec = new RecordDir(dir, TaskSchema);
  }
  get(id: string) {
    return this.rec.get(id);
  }
  list() {
    return this.rec.list().sort((a, b) => b.created_at - a.created_at);
  }
  create(text: string, maxAmount: bigint, now: number, agentId?: string): Task {
    const t: Task = {
      ...(agentId && { agent_id: agentId }),
      id: newId("task"),
      text,
      max_amount_raw: uintToString(maxAmount),
      max_amount: formatAmount(maxAmount),
      created_at: now,
      updated_at: now,
      status: "open",
      order_refs: [],
    };
    this.rec.put(t.id, t);
    return t;
  }
  /** 주인이 멈춤: 대기·진행·결제됨 상태만. 멈춘 동안 next_task로 주지 않고, 이 일로는 결제·승인이 안 된다 */
  pause(id: string, now: number): Task | "invalid" | undefined {
    const t = this.rec.get(id);
    if (!t) return undefined;
    if (t.status !== "open" && t.status !== "working" && t.status !== "paid") return "invalid";
    const next: Task = { ...t, status: "paused", paused_from: t.status, updated_at: now };
    this.rec.put(id, next);
    return next;
  }
  resume(id: string, now: number): Task | "invalid" | undefined {
    const t = this.rec.get(id);
    if (!t) return undefined;
    if (t.status !== "paused") return "invalid";
    const { paused_from, ...rest } = t;
    // 결제까지 끝난 일은 그대로, 청구서(주문)가 이미 있으면 진행 중, 없으면 대기로
    const status: Task["status"] = paused_from === "paid" ? "paid" : t.order_refs.length > 0 ? "working" : "open";
    const next: Task = { ...rest, status, updated_at: now };
    this.rec.put(id, next);
    return next;
  }
  update(id: string, patch: Partial<Pick<Task, "status" | "agent" | "note">> & { addOrder?: string }, now: number) {
    const t = this.rec.get(id);
    if (!t) return undefined;
    const { addOrder, ...rest } = patch;
    const next: Task = {
      ...t,
      ...rest,
      updated_at: now,
      order_refs: addOrder && !t.order_refs.includes(addOrder) ? [...t.order_refs, addOrder] : t.order_refs,
    };
    this.rec.put(id, next);
    return next;
  }
  /** 가장 오래된 대기 일 */
  nextOpen(agentId?: string): Task | undefined {
    return this.list()
      .filter((t) => t.status === "open" && (!t.agent_id || t.agent_id === agentId))
      .sort((a, b) => a.created_at - b.created_at)[0];
  }
  /** checkOrder에 넘길 일 정보 */
  extraFor(id: string | undefined, agentId?: string): CheckExtras["task"] {
    if (!id) return undefined;
    const t = this.rec.get(id);
    if (!t) return undefined;
    const mine = !t.agent_id || agentId === undefined || t.agent_id === agentId;
    return { id: t.id, maxAmount: parseUint(t.max_amount_raw), active: mine && ACTIVE.includes(t.status), status: t.status };
  }
}

// ─── 에이전트 연결 (원격 MCP 주소·토큰) ───────────────────────────────────────

export const ConnectionSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(64),
  /** 토큰 원문은 저장하지 않는다 */
  token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: z.number().int(),
  disconnected_at: z.number().int().optional(),
  /** 이 에이전트 하나만 멈춘 시각 (없으면 동작 중). 멈춘 동안 이 연결로 들어온 pay_order는 WALLET_PAUSED */
  paused_at: z.number().int().optional(),
  /** 이 에이전트의 계정 번호 (니모닉 m/44'/60'/0'/0/n). 11/26 이전 연결은 없음 → 1번 */
  account_index: z.number().int().min(1).max(1000).optional(),
  /** 맡긴 일 실행기(apps/runner)용 두 번째 토큰. 원래 연결 주소를 그대로 둔 채 같은 에이전트로 붙는다 */
  runner_token_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** 주인이 목록에서 숨긴 시각 (끊긴 연결 + 잔액 0일 때만). 정책·내역·결제 기록은 그대로 남는다 */
  hidden_at: z.number().int().optional(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export class ConnectionStore {
  private readonly rec: RecordDir<Connection>;
  constructor(dir: string) {
    this.rec = new RecordDir(dir, ConnectionSchema);
  }
  static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
  list() {
    return this.rec.list().sort((a, b) => b.created_at - a.created_at);
  }
  /** 새 연결: 토큰 원문은 이때 한 번만 돌려준다 */
  create(name: string, now: number, accountIndex?: number): { connection: Connection; token: string } {
    const token = `cs_${randomBytes(24).toString("base64url")}`;
    const connection: Connection = {
      id: newId("agent"),
      name,
      token_sha256: ConnectionStore.hash(token),
      created_at: now,
      ...(accountIndex !== undefined && { account_index: accountIndex }),
    };
    this.rec.put(connection.id, connection);
    return { connection, token };
  }
  get(id: string) {
    return this.rec.get(id);
  }
  /** 이름 바꾸기. 살아 있는 다른 연결과 같은 이름이면 undefined가 아니라 "duplicate" */
  rename(id: string, name: string): Connection | "duplicate" | undefined {
    const c = this.rec.get(id);
    if (!c) return undefined;
    if (this.rec.list().some((o) => o.id !== id && o.name === name && !o.disconnected_at)) return "duplicate";
    const next = { ...c, name };
    this.rec.put(id, next);
    return next;
  }
  setPaused(id: string, paused: boolean, now: number): Connection | undefined {
    const c = this.rec.get(id);
    if (!c) return undefined;
    const { paused_at: _p, ...rest } = c;
    const next: Connection = paused ? { ...rest, paused_at: c.paused_at ?? now } : rest;
    this.rec.put(id, next);
    return next;
  }
  setHidden(id: string, hidden: boolean, now: number): Connection | undefined {
    const c = this.rec.get(id);
    if (!c) return undefined;
    const { hidden_at: _h, ...rest } = c;
    const next: Connection = hidden ? { ...rest, hidden_at: c.hidden_at ?? now } : rest;
    this.rec.put(id, next);
    return next;
  }
  disconnect(id: string, now: number): Connection | undefined {
    const c = this.rec.get(id);
    if (!c || c.disconnected_at) return c;
    const next = { ...c, disconnected_at: now };
    this.rec.put(id, next);
    return next;
  }
  /** 살아 있는 연결 중 토큰(연결 토큰 또는 실행기 토큰)이 맞는 것 */
  authenticate(token: string): Connection | undefined {
    if (!/^cs_[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
    const h = ConnectionStore.hash(token);
    return this.rec.list().find((c) => !c.disconnected_at && (c.token_sha256 === h || c.runner_token_sha256 === h));
  }
  /** 실행기 토큰 새로 만들기 (이전 실행기 토큰은 무효). 원문은 이때 한 번만 */
  issueRunnerToken(id: string): string | undefined {
    const c = this.rec.get(id);
    if (!c || c.disconnected_at) return undefined;
    const token = `cs_${randomBytes(24).toString("base64url")}`;
    this.rec.put(id, { ...c, runner_token_sha256: ConnectionStore.hash(token) });
    return token;
  }
}

// ─── 에이전트가 실제로 붙었는지 (원격 MCP가 쓴다) ─────────────────────────────

export const SeenSchema = z.object({
  /** 그 토큰으로 MCP initialize에 처음 성공한 시각 */
  attached_at: z.number().int().optional(),
  /** 마지막 MCP 요청 시각 */
  last_seen_at: z.number().int().optional(),
});
export type Seen = z.infer<typeof SeenSchema>;

/** 연결 기록과 파일을 나눠, 주인 API(이름·멈춤)와 지갑 MCP(활동 시각)가 같은 파일을 동시에 쓰지 않게 한다 */
export class SeenStore {
  private readonly rec: RecordDir<Seen>;
  private readonly lastWrite = new Map<string, number>();
  constructor(dir: string) {
    this.rec = new RecordDir(dir, SeenSchema);
  }
  get(id: string): Seen {
    return this.rec.get(id) ?? {};
  }
  /** 요청이 올 때마다 부른다. initialize 성공이면 attached=true. 같은 연결은 10초에 한 번만 쓴다 */
  touch(id: string, now: number, attached = false): void {
    const prev = this.rec.get(id) ?? {};
    if (!attached && prev.attached_at && now - (this.lastWrite.get(id) ?? 0) < 10) return;
    this.rec.put(id, { ...prev, last_seen_at: now, ...(attached && !prev.attached_at && { attached_at: now }) });
    this.lastWrite.set(id, now);
  }
}
