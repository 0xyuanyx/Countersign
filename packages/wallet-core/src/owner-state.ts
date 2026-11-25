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
  static idFor(orderRef: string): string {
    return `req_${createHash("sha256").update(orderRef).digest("hex").slice(0, 16)}`;
  }

  get(id: string) {
    return this.rec.get(id);
  }
  forOrder(orderRef: string) {
    return this.rec.get(ApprovalStore.idFor(orderRef));
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
    now: number;
  }): ApprovalRequest {
    const existing = this.forOrder(args.order.orderRef);
    if (existing) return existing;
    const req: ApprovalRequest = {
      id: ApprovalStore.idFor(args.order.orderRef),
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
  approvalFor(orderRef: string): CheckExtras["approval"] {
    const r = this.forOrder(orderRef);
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
  /** open: 대기 / working: 에이전트가 받아 감 / paid: 결제됨 / done·failed: 에이전트 보고 / cancelled: 주인이 그만둠 */
  status: z.enum(["open", "working", "paid", "done", "failed", "cancelled"]),
  agent: z.string().optional(),
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
  create(text: string, maxAmount: bigint, now: number): Task {
    const t: Task = {
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
  nextOpen(): Task | undefined {
    return this.list()
      .filter((t) => t.status === "open")
      .sort((a, b) => a.created_at - b.created_at)[0];
  }
  /** checkOrder에 넘길 일 정보 */
  extraFor(id: string | undefined): CheckExtras["task"] {
    if (!id) return undefined;
    const t = this.rec.get(id);
    if (!t) return undefined;
    return { id: t.id, maxAmount: parseUint(t.max_amount_raw), active: ACTIVE.includes(t.status) };
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
  create(name: string, now: number): { connection: Connection; token: string } {
    const token = `cs_${randomBytes(24).toString("base64url")}`;
    const connection: Connection = { id: newId("agent"), name, token_sha256: ConnectionStore.hash(token), created_at: now };
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
  disconnect(id: string, now: number): Connection | undefined {
    const c = this.rec.get(id);
    if (!c || c.disconnected_at) return c;
    const next = { ...c, disconnected_at: now };
    this.rec.put(id, next);
    return next;
  }
  /** 살아 있는 연결 중 토큰이 맞는 것 */
  authenticate(token: string): Connection | undefined {
    if (!/^cs_[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
    const h = ConnectionStore.hash(token);
    return this.rec.list().find((c) => !c.disconnected_at && c.token_sha256 === h);
  }
}
