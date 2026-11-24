import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseUint, uintToString } from "./amount.js";
import type { SpendLedger } from "./policy.js";

/**
 * 로컬 상태 파일 (~/.countersign, COUNTERSIGN_HOME으로 바꿀 수 있음).
 * 지갑 MCP·signer·주인 API가 같은 폴더를 본다. 폴더는 0700, 파일은 0600.
 * 키·서명 원문은 여기에 쓰지 않는다 (AGENTS.md 규칙 2).
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COUNTERSIGN_HOME || join(homedir(), ".countersign");
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writePrivate(path: string, text: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function appendPrivate(path: string, line: string): void {
  ensureDir(dirname(path));
  appendFileSync(path, `${line}\n`, { mode: 0o600 });
}

function readJsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 깨진 줄(쓰다가 끊긴 마지막 줄 등)은 건너뛴다
    }
  }
  return out;
}

// ─── 지출 기록 (일일 한도·중복 결제) ──────────────────────────────────────────

const LedgerLineSchema = z.object({ orderRef: z.string(), amount: z.string(), at: z.number().int() });

/**
 * 파일에 남는 지출 기록. 프로세스를 다시 켜도 일일 한도와 중복 결제 검사가 이어진다.
 * 한 프로세스가 한 파일을 쓴다 (signer는 signer-ledger.jsonl, 지갑 MCP는 wallet-ledger.jsonl).
 */
export class FileSpendLedger implements SpendLedger {
  private readonly entries: { orderRef: string; amount: bigint; at: number }[] = [];
  private readonly paid = new Set<string>();

  constructor(private readonly path: string) {
    for (const raw of readJsonLines(path)) {
      const p = LedgerLineSchema.safeParse(raw);
      if (!p.success) continue;
      this.entries.push({ orderRef: p.data.orderRef, amount: parseUint(p.data.amount), at: p.data.at });
      this.paid.add(p.data.orderRef);
    }
  }
  spentSince(since: number): bigint {
    return this.entries.filter((e) => e.at > since).reduce((s, e) => s + e.amount, 0n);
  }
  isPaid(orderRef: string): boolean {
    return this.paid.has(orderRef);
  }
  record(orderRef: string, amount: bigint, at: number): void {
    if (this.paid.has(orderRef)) throw new Error("이미 기록된 주문");
    appendPrivate(this.path, JSON.stringify({ orderRef, amount: uintToString(amount), at }));
    this.paid.add(orderRef);
    this.entries.push({ orderRef, amount, at });
  }
}

// ─── 결제 정지 스위치 ─────────────────────────────────────────────────────────

const PauseSchema = z.object({ paused: z.boolean(), at: z.number().int(), reason: z.string().max(200).optional() });
export type PauseState = z.infer<typeof PauseSchema>;

/**
 * 주인의 정지 스위치. 주인 API(앱)만 쓴다. MCP 도구로는 열지 않는다 (AGENTS.md 규칙 4).
 * 지갑 MCP와 signer가 결제·서명할 때마다 다시 읽는다. 파일이 깨져 있으면 "정지"로 본다 (fail-closed).
 */
export function readPause(path: string): PauseState {
  if (!existsSync(path)) return { paused: false, at: 0 };
  try {
    const p = PauseSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return p.success ? p.data : { paused: true, at: 0, reason: "정지 파일을 읽을 수 없음" };
  } catch {
    return { paused: true, at: 0, reason: "정지 파일을 읽을 수 없음" };
  }
}

export function writePause(path: string, state: PauseState): void {
  writePrivate(path, JSON.stringify(PauseSchema.parse(state)));
}

// ─── 결제 내역 (승인·거부) ────────────────────────────────────────────────────

export const HistoryEntrySchema = z.object({
  id: z.string(),
  at: z.number().int(),
  order_ref: z.string(),
  /** paid: HSP 완료까지 확인 / rejected: 서명 안 함 / failed: 서명 후 HSP 단계에서 실패 */
  status: z.enum(["paid", "rejected", "failed"]),
  seller: z.string().optional(),
  purpose: z.string().optional(),
  /** 사람이 읽는 USDC 금액 ("0.1"). 주문을 못 읽은 거부에는 없다 */
  amount: z.string().optional(),
  pay_to: z.string().optional(),
  chain_id: z.number().int().optional(),
  code: z.string().optional(),
  step: z.string().optional(),
  reason: z.string().optional(),
  next_action: z.string().optional(),
  payment_id: z.string().optional(),
  hsp_status: z.string().optional(),
  tx_hash: z.string().optional(),
  order_hash: z.string().optional(),
  typed_data_hash: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export class HistoryStore {
  constructor(private readonly path: string) {}

  append(entry: HistoryEntry): void {
    appendPrivate(this.path, JSON.stringify(HistoryEntrySchema.parse(entry)));
  }

  /** 최신순 */
  list(limit = 20): HistoryEntry[] {
    const all: HistoryEntry[] = [];
    for (const raw of readJsonLines(this.path)) {
      const p = HistoryEntrySchema.safeParse(raw);
      if (p.success) all.push(p.data);
    }
    return all.reverse().slice(0, Math.max(0, limit));
  }
}

export interface StatePaths {
  dir: string;
  pause: string;
  history: string;
  walletLedger: string;
  signerLedger: string;
  ticketSecret: string;
  ownerToken: string;
  signerSocket: string;
}

export function statePaths(env: NodeJS.ProcessEnv = process.env): StatePaths {
  const dir = stateDir(env);
  return {
    dir,
    pause: join(dir, "pause.json"),
    history: join(dir, "history.jsonl"),
    walletLedger: join(dir, "wallet-ledger.jsonl"),
    signerLedger: join(dir, "signer-ledger.jsonl"),
    ticketSecret: join(dir, "ticket.secret"),
    ownerToken: join(dir, "owner.token"),
    signerSocket: env.COUNTERSIGN_SIGNER_SOCKET || join(dir, "signer.sock"),
  };
}

/**
 * 비밀이 아닌 "프로세스 사이 공유값"(검증 티켓 HMAC 키, 주인 API 토큰)을 0600 파일로 둔다.
 * 서명 키가 아니다. 없으면 만들고, 있으면 읽는다. 값은 출력하지 않는다.
 */
export function readOrCreateSharedSecret(path: string, create: boolean): string | undefined {
  if (existsSync(path)) {
    const v = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(v)) return v;
    if (!create) return undefined;
  }
  if (!create) return undefined;
  const v = randomBytes(32).toString("hex");
  writePrivate(path, v);
  return v;
}
