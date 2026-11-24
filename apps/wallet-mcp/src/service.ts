import { randomBytes } from "node:crypto";
import { HspError, type HspClient, type QueryResult } from "@countersign/hsp";
import type { SignerResponse } from "@countersign/signer";
import {
  checkOrder,
  checkSignature,
  describeChecks,
  parseTypedData,
  formatAmount,
  issueTicket,
  normalizeOrder,
  reject,
  summarizePolicy,
  verifyPayment,
  type HistoryEntry,
  type HistoryStore,
  type Order,
  type PauseState,
  type Policy,
  type PolicySummary,
  type Rejection,
  type SpendLedger,
  type Ticket,
  type TwaTypedData,
} from "@countersign/wallet-core";
import type { Address, Hex } from "viem";
import { z } from "zod";

/**
 * 지갑 MCP 서버의 본체 (PROJECT.md §5.1). 키는 없다. 서명은 signer 프로세스에 티켓과 함께 부탁한다.
 * 에이전트가 준 값은 믿지 않는다: order_ref로 HSP에서 주문을 다시 가져오고, intent는 "상한"으로만 쓴다.
 * 정책 변경·키 내보내기·임의 서명 기능은 없다 (AGENTS.md 규칙 4, 6).
 */
export interface SignerPort {
  address(): Promise<SignerResponse>;
  signPayment(ticket: Ticket, typedData: unknown): Promise<SignerResponse>;
}

export interface BalanceReader {
  /** 체인별 USDC 잔액 (최소 단위). 읽지 못하면 throw */
  usdcBalance(chainId: number, token: Address, owner: Address): Promise<bigint>;
}

export interface WalletDeps {
  hsp: HspClient;
  signer: SignerPort;
  policy: Policy;
  ticketSecret: Buffer;
  ledger: SpendLedger;
  history: HistoryStore;
  pause: () => PauseState;
  balances?: BalanceReader;
  /** "mock"이면 결과에 "돈은 움직이지 않음"을 같이 알린다 */
  hspMode: "mock" | "mcp";
  now?: () => number;
  /** query_payment 폴링 간격·한도 */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export const PayOrderInputSchema = z
  .object({
    order_ref: z.string().min(1).max(200),
    intent: z.unknown(),
  })
  .strict();

export interface PaySuccess {
  ok: true;
  order_ref: string;
  payment_id: string;
  /** payment-finalized가 아니면 판매자가 아직 납품하지 않을 수 있다 */
  hsp_status: QueryResult["status"];
  tx_hash?: string;
  amount: string;
  token: "USDC";
  pay_to: string;
  seller: string;
  chain_id: number;
  evidence: { order_hash: Hex; typed_data_hash: Hex };
  next_action: string;
  note?: string;
}

export type PayResult = PaySuccess | Rejection;

export class WalletService {
  private agentAddress: Address | undefined;
  private readonly now: () => number;
  /** 같은 순간에 두 결제가 일일 한도를 같이 통과하지 않게 한 번에 하나씩 */
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: WalletDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** 에이전트 계정 주소 (signer에게 묻는다. 키는 모른다) */
  async account(): Promise<Address | Rejection> {
    if (this.agentAddress) return this.agentAddress;
    let r: SignerResponse;
    try {
      r = await this.d.signer.address();
    } catch {
      return reject("SIGNER_UNAVAILABLE", "signature", "signer 프로세스에 연결할 수 없음");
    }
    if (!r.ok || r.op !== "address") return reject("SIGNER_UNAVAILABLE", "signature", "signer가 주소를 주지 않음");
    this.agentAddress = r.address;
    return r.address;
  }

  async getPolicy(): Promise<PolicySummary> {
    const acct = await this.account();
    return summarizePolicy(this.d.policy, this.d.ledger, this.d.pause(), this.now(), typeof acct === "string" ? acct : undefined);
  }

  async getBalance(): Promise<
    | {
        ok: true;
        account: Address;
        balances: { chain_id: number; token: "USDC"; balance?: string; error?: string }[];
        remaining_24h: string;
        per_tx_max: string;
        note?: string;
      }
    | Rejection
  > {
    const acct = await this.account();
    if (typeof acct !== "string") return acct;
    const summary = summarizePolicy(this.d.policy, this.d.ledger, this.d.pause(), this.now(), acct);
    const balances = await Promise.all(
      [...this.d.policy.tokens].map(async ([chainId, token]) => {
        if (!this.d.balances) return { chain_id: chainId, token: "USDC" as const, error: "잔액 조회기가 없음" };
        try {
          const v = await this.d.balances.usdcBalance(chainId, token, acct);
          return { chain_id: chainId, token: "USDC" as const, balance: formatAmount(v) };
        } catch {
          return { chain_id: chainId, token: "USDC" as const, error: "RPC 조회 실패" };
        }
      }),
    );
    return {
      ok: true,
      account: acct,
      balances,
      remaining_24h: summary.remaining_24h,
      per_tx_max: summary.per_tx_max,
      ...(this.d.hspMode === "mock" && { note: "HSP mock 모드: 결제는 이 잔액을 쓰지 않는다 (돈이 움직이지 않음)" }),
    };
  }

  getHistory(limit: number): HistoryEntry[] {
    return this.d.history.list(Math.min(Math.max(limit, 1), 100));
  }

  payOrder(input: unknown): Promise<PayResult> {
    const run = this.busy.then(() => this.payOrderInner(input));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async payOrderInner(input: unknown): Promise<PayResult> {
    const id = randomBytes(8).toString("hex");
    const parsedInput = PayOrderInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return this.rejected(id, "?", reject("INVALID_INPUT", "input", "order_ref(문자열)와 intent가 필요함"));
    }
    const { order_ref: orderRef, intent } = parsedInput.data;
    const intentInfo = intentFields(intent);
    const ctx: CheckCtx = { intent };

    // 0. 주인의 정지 스위치
    const pause = this.d.pause();
    if (pause.paused) return this.rejected(id, orderRef, reject("PAUSED", "pause", "주인이 결제를 정지함"), intentInfo);

    const agent = await this.account();
    if (typeof agent !== "string") return this.rejected(id, orderRef, agent, intentInfo);
    ctx.agent = agent;

    // 1. 주문을 HSP에서 직접 다시 가져온다 (에이전트·판매자가 말한 금액·주소는 쓰지 않는다)
    let order: Order;
    try {
      order = normalizeOrder(await this.d.hsp.getOrder(orderRef));
    } catch (e) {
      return this.rejected(id, orderRef, hspRejection("get_order", e), intentInfo);
    }
    if (order.orderRef !== orderRef) {
      return this.rejected(id, orderRef, reject("TYPED_DATA_MISMATCH", "hsp", "HSP가 다른 주문을 돌려줌"), intentInfo, order, ctx);
    }
    ctx.order = order;

    // 2. 정책·의도 검사 (prepare 전에 한 번: 나쁜 주문이면 HSP에 서명 대상을 만들게 하지도 않는다)
    const pre = checkOrder(order, intent, this.d.policy, this.d.ledger, this.now());
    if (!pre.ok) return this.rejected(id, orderRef, pre, intentInfo, order, ctx);

    // 3. 서명 대상 받기 → 주문과 필드별 대조
    let typedData: unknown;
    let payload: unknown;
    try {
      const p = await this.d.hsp.preparePayment(orderRef, agent);
      typedData = p.typed_data;
      payload = p.payment_payload;
    } catch (e) {
      return this.rejected(id, orderRef, hspRejection("prepare_payment", e), intentInfo, order, ctx);
    }
    const t = this.now();
    const parsedTd = parseTypedData(typedData);
    if (parsedTd.ok) ctx.td = parsedTd.td;
    const v = verifyPayment({ order, intent, policy: this.d.policy, ledger: this.d.ledger, typedData, agent, now: t });
    if (!v.ok) return this.rejected(id, orderRef, v, intentInfo, order, ctx);

    // 4. 검증 티켓과 함께 signer에 서명 요청 (signer는 같은 검사를 처음부터 다시 한다)
    const ticket = issueTicket(this.d.ticketSecret, { typedDataHash: v.typedDataHash, order, intent: v.intent, now: t });
    let signed: SignerResponse;
    try {
      signed = await this.d.signer.signPayment(ticket, typedData);
    } catch {
      return this.rejected(id, orderRef, reject("SIGNER_UNAVAILABLE", "signature", "signer 프로세스에 연결할 수 없음"), intentInfo, order, ctx);
    }
    if (!signed.ok) return this.rejected(id, orderRef, signed, intentInfo, order, ctx);
    if (signed.op !== "sign_payment" || signed.typedDataHash.toLowerCase() !== v.typedDataHash.toLowerCase()) {
      return this.rejected(id, orderRef, reject("SIGNATURE_INVALID", "signature", "signer 응답이 요청과 다름"), intentInfo, order, ctx);
    }
    const sigCheck = await checkSignature(v.td, signed.signature, agent);
    if (!sigCheck.ok) return this.rejected(id, orderRef, sigCheck, intentInfo, order, ctx);

    // 서명이 나간 순간부터 지출로 센다 (HSP 단계가 실패해도 같은 주문을 다시 서명하지 않는다, 오류 30043)
    this.d.ledger.record(order.orderRef, order.amount, t);
    const base = {
      seller: v.intent.seller,
      purpose: v.intent.purpose,
      amount: formatAmount(order.amount),
      pay_to: order.payTo,
      chain_id: order.chainId,
      order_hash: v.orderHash,
      typed_data_hash: v.typedDataHash,
      checks: this.checks(ctx),
    };
    const events: { stage: string; at: number }[] = [{ stage: "signed", at: t }];

    // 5. HSP에 제출하고 완료까지 기다린다
    let paymentId: string | undefined;
    try {
      paymentId = (await this.d.hsp.finalizePayment(orderRef, signed.signature, payload)).payment_id;
      events.push({ stage: "finalized", at: this.now() });
      const sub = await this.d.hsp.submitPayment(paymentId);
      events.push({ stage: "submitted", at: this.now() });
      const q = await this.waitFinal(paymentId, events);
      if (q.status === "failed") throw new HspError("query_payment", "FAILED", "HSP가 결제 실패를 알림");
      const txHash = q.tx_hash ?? sub.tx_hash;
      const entry: HistoryEntry = {
        id,
        at: this.now(),
        order_ref: orderRef,
        status: "paid",
        ...base,
        payment_id: paymentId,
        hsp_status: q.status,
        ...(txHash && { tx_hash: txHash }),
        events,
      };
      this.d.history.append(entry);
      return {
        ok: true,
        order_ref: orderRef,
        payment_id: paymentId,
        hsp_status: q.status,
        ...(txHash && { tx_hash: txHash }),
        amount: base.amount,
        token: "USDC",
        pay_to: order.payTo,
        seller: v.intent.seller,
        chain_id: order.chainId,
        evidence: { order_hash: v.orderHash, typed_data_hash: v.typedDataHash },
        next_action:
          q.status === "payment-finalized"
            ? "판매자에게 order_ref와 payment_id를 보내 납품을 요청한다"
            : "결제가 아직 확정 전이다. 잠시 뒤 판매자에게 order_ref와 payment_id를 보내 납품을 요청한다",
        ...(this.d.hspMode === "mock" && { note: "HSP mock 결제: 실제 돈은 움직이지 않았고 tx_hash는 가짜다" }),
      };
    } catch (e) {
      const r = hspRejection("submit", e);
      this.d.history.append({
        id,
        at: this.now(),
        order_ref: orderRef,
        status: "failed",
        ...base,
        ...(paymentId && { payment_id: paymentId }),
        events,
        code: r.code,
        step: r.step,
        reason: r.reason,
        next_action: "서명은 이미 나갔다. 같은 주문을 다시 결제하지 말고 사람(주인)에게 보고한다",
      });
      return { ...r, next_action: "서명은 이미 나갔다. 같은 주문을 다시 결제하지 말고 사람(주인)에게 보고한다" };
    }
  }

  private async waitFinal(paymentId: string, events: { stage: string; at: number }[]): Promise<QueryResult> {
    const interval = this.d.pollIntervalMs ?? 2000;
    const deadline = Date.now() + (this.d.pollTimeoutMs ?? 120_000);
    const seen = (status: string) => {
      if (!events.some((e) => e.stage === status)) events.push({ stage: status, at: this.now() });
    };
    let q = await this.d.hsp.queryPayment(paymentId);
    seen(q.status);
    while (q.status !== "payment-finalized" && q.status !== "failed" && Date.now() < deadline) {
      if (interval > 0) await new Promise((r) => setTimeout(r, interval));
      q = await this.d.hsp.queryPayment(paymentId);
      seen(q.status);
    }
    return q;
  }

  private checks(ctx: CheckCtx) {
    return describeChecks({ policy: this.d.policy, now: this.now(), ...ctx });
  }

  private rejected(
    id: string,
    orderRef: string,
    r: Rejection,
    intent: { seller?: string; purpose?: string } = {},
    order?: Order,
    ctx?: CheckCtx,
  ): Rejection {
    this.d.history.append({
      id,
      at: this.now(),
      order_ref: orderRef,
      status: "rejected",
      ...intent,
      ...(order && { amount: formatAmount(order.amount), pay_to: order.payTo, chain_id: order.chainId }),
      code: r.code,
      step: r.step,
      reason: r.reason,
      next_action: r.next_action,
      ...(ctx?.order && { checks: this.checks(ctx) }),
    });
    return r;
  }
}

interface CheckCtx {
  intent: unknown;
  agent?: Address;
  order?: Order;
  td?: TwaTypedData;
}

function intentFields(intent: unknown): { seller?: string; purpose?: string } {
  if (!intent || typeof intent !== "object") return {};
  const o = intent as Record<string, unknown>;
  return {
    ...(typeof o.seller === "string" && { seller: o.seller.slice(0, 64) }),
    ...(typeof o.purpose === "string" && { purpose: o.purpose.slice(0, 200) }),
  };
}

/** HSP 오류 → 에이전트가 읽는 거부. HSP 원문은 길이를 잘라서만 넣는다. */
function hspRejection(where: string, e: unknown): Rejection {
  if (e instanceof HspError) {
    if (e.hspCode === "NOT_FOUND") return reject("HSP_ERROR", "hsp", `HSP에 그런 주문이 없음 (${where})`);
    return reject("HSP_ERROR", "hsp", `${where}: ${String(e.hspCode ?? "")} ${e.message}`.slice(0, 300));
  }
  if (e instanceof z.ZodError) return reject("HSP_ERROR", "hsp", `${where}: HSP 응답 형식이 예상과 다름`);
  return reject("HSP_ERROR", "hsp", `${where}: HSP 호출 실패`);
}
