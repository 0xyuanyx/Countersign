import { randomBytes } from "node:crypto";
import { HspError, explorerUrl, type HspClient, type QueryResult } from "@countersign/hsp";
import type { SignerResponse } from "@countersign/signer";
import {
  approvalMatches,
  checkOrder,
  checkSignature,
  describeChecks,
  parseTypedData,
  resolvePolicy,
  formatAmount,
  issueTicket,
  normalizeOrder,
  reject,
  summarizePolicy,
  verifyPayment,
  type ApprovalStore,
  type CheckExtras,
  type HistoryEntry,
  type Task,
  type TaskStore,
  type HistoryStore,
  type Order,
  type PauseState,
  type Policy,
  type PolicyInput,
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
  /** 함수로 주면 결제할 때마다 다시 읽는다 */
  policy: PolicyInput;
  ticketSecret: Buffer;
  ledger: SpendLedger;
  history: HistoryStore;
  pause: () => PauseState;
  /** 주인 결정 상태 (구매 승인 요청, 맡긴 일). 없으면 승인 요청을 만들지 않고 거절만 한다 */
  approvals?: ApprovalStore;
  tasks?: TaskStore;
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
    return summarizePolicy(this.pol(), this.d.ledger, this.d.pause(), this.now(), typeof acct === "string" ? acct : undefined);
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
    const policy = this.pol();
    const summary = summarizePolicy(policy, this.d.ledger, this.d.pause(), this.now(), acct);
    const balances = await Promise.all(
      [...policy.tokens].map(async ([chainId, token]) => {
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

  /**
   * 이 에이전트의 내역만 (11/27 리뷰 P2-5: 다른 에이전트의 결제 목적·금액·수취인·출금이 보이지 않게).
   * 확인 중(confirming)인 결제는 돌려주기 전에 HSP에 한 번 더 묻는다.
   */
  async getHistory(limit: number, who: string | Caller = "local"): Promise<HistoryEntry[]> {
    const c: Caller = typeof who === "string" ? { name: who } : who;
    const n = Math.min(Math.max(limit, 1), 100);
    const confirming = this.d.history.list(500).filter((e) => e.status === "confirming" && this.mine(e, c)).slice(0, 3);
    for (const e of confirming) await this.checkPayment(e.order_ref, c).catch(() => undefined);
    return this.d.history
      .list(2000)
      .filter((e) => this.mine(e, c))
      .slice(0, n);
  }

  /**
   * caller: 결제를 요청한 에이전트 연결 (내역·승인 요청에 남는다).
   * caller.paused: 주인이 이 에이전트 하나만 멈췄는지 (결제마다 다시 묻는다)
   */
  payOrder(input: unknown, caller: string | Caller = "local"): Promise<PayResult> {
    const c: Caller = typeof caller === "string" ? { name: caller } : caller;
    const run = this.busy.then(() => this.payOrderInner(input, c));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async payOrderInner(input: unknown, who: Caller): Promise<PayResult> {
    const caller = who.name;
    const id = randomBytes(8).toString("hex");
    const parsedInput = PayOrderInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return this.rejected(id, "?", reject("INVALID_INPUT", "input", "order_ref(문자열)와 intent가 필요함"));
    }
    const { order_ref: orderRef, intent } = parsedInput.data;
    const intentInfo = intentFields(intent);
    let policy: Policy;
    try {
      policy = this.pol();
    } catch {
      return this.rejected(id, orderRef, reject("POLICY_INVALID", "policy", "정책 파일을 읽을 수 없음"), intentInfo);
    }
    const ctx: CheckCtx = { intent, policy, caller, ...(who.id && { callerId: who.id }) };

    // 0. 주인의 정지 스위치
    const pause = this.d.pause();
    if (pause.paused) return this.rejected(id, orderRef, reject("WALLET_PAUSED", "pause", "주인이 결제를 정지함"), intentInfo, undefined, ctx);
    if (who.paused?.()) {
      return this.rejected(id, orderRef, reject("WALLET_PAUSED", "pause", `주인이 이 에이전트(${caller})를 멈춤`), intentInfo, undefined, ctx);
    }

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
    // 맡긴 일로 받은 청구서는 그 일에 붙여 둔다 (상태는 바꾸지 않는다: 멈춘 일은 멈춘 채로)
    if (intentInfo.task_id) {
      const t = this.d.tasks?.get(intentInfo.task_id);
      if (t && (!t.agent_id || t.agent_id === (who.id ?? "local"))) {
        this.d.tasks!.update(t.id, { addOrder: orderRef }, this.now());
      }
    }

    // 2. 정책·의도 검사 (prepare 전에 한 번: 나쁜 주문이면 HSP에 서명 대상을 만들게 하지도 않는다)
    const extras = this.extras(orderRef, intentInfo.task_id, who.id);
    ctx.approved = approvalMatches(extras.approval, order);
    const pre = checkOrder(order, intent, policy, this.d.ledger, this.now(), extras);
    if (!pre.ok) {
      if (pre.code === "NEEDS_OWNER_APPROVAL") return this.needsApproval(id, orderRef, pre, intentInfo, order, ctx);
      return this.rejected(id, orderRef, pre, intentInfo, order, ctx);
    }
    if (pre.intent.task_id) this.d.tasks?.update(pre.intent.task_id, { status: "working", agent: caller, addOrder: orderRef }, this.now());

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
    const v = verifyPayment({ order, intent, policy, ledger: this.d.ledger, typedData, agent, now: t, extras });
    if (!v.ok) return this.rejected(id, orderRef, v, intentInfo, order, ctx);

    // 4. 검증 티켓과 함께 signer에 서명 요청 (signer는 같은 검사를 처음부터 다시 한다)
    const ticket = issueTicket(this.d.ticketSecret, {
      typedDataHash: v.typedDataHash,
      order,
      intent: v.intent,
      now: t,
      ...(who.id && { agent: who.id }),
    });
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
      agent: caller,
      ...(who.id && { agent_id: who.id }),
      ...(v.intent.task_id && { task_id: v.intent.task_id }),
    };
    const events: { stage: string; at: number }[] = [{ stage: "signed", at: t }];

    // 5. HSP에 제출하고 완료까지 기다린다
    //    - finalize 전에 실패: 돈은 나가지 않았다 → failed
    //    - finalize 뒤(제출·조회)에 끊기거나 시간이 다 됨: 결과를 모른다 → confirming (같은 주문을 다시 결제하지 말고 check_payment로 이어서 확인)
    //    - HSP가 failed를 알림 → failed
    //    - payment-finalized만 paid (맡긴 일도 그때만 paid)
    let paymentId: string;
    try {
      paymentId = (await this.d.hsp.finalizePayment(orderRef, signed.signature, payload)).payment_id;
    } catch (e) {
      const r = hspRejection("finalize", e);
      const next_action = "HSP가 서명을 받지 않아 돈은 나가지 않았다. 같은 주문은 다시 서명할 수 없으니 판매자에게 새 주문을 요청한다";
      this.d.history.append({ id, at: this.now(), order_ref: orderRef, status: "failed", ...base, events, code: r.code, step: r.step, reason: r.reason, next_action });
      return { ...r, next_action };
    }
    events.push({ stage: "finalized", at: this.now() });
    const pending: PendingPayment = { id, orderRef, paymentId, base, events, agent, order, v };
    let subTx: string | undefined;
    try {
      subTx = (await this.d.hsp.submitPayment(paymentId)).tx_hash;
      events.push({ stage: "submitted", at: this.now() });
    } catch (e) {
      return this.unconfirmed(pending, hspRejection("submit", e).reason);
    }
    let q: QueryResult;
    try {
      q = await this.waitFinal(paymentId, events);
    } catch (e) {
      return this.unconfirmed(pending, hspRejection("query", e).reason, subTx);
    }
    return this.settle(pending, q, subTx);
  }

  /** HSP 조회 결과로 내역·맡긴 일을 정리한다 (처음 결제와 check_payment 둘 다) */
  private settle(p: PendingPayment, q: QueryResult, subTx?: string): PayResult {
    const txHash = q.tx_hash ?? subTx;
    const common = {
      id: p.id,
      at: this.now(),
      order_ref: p.orderRef,
      kind: "payment" as const,
      ...p.base,
      from: p.agent,
      payment_id: p.paymentId,
      hsp_status: q.status,
      ...(txHash && { tx_hash: txHash }),
      ...(this.d.hspMode === "mock" ? { simulated: true } : txHash && { explorer_url: explorerUrl(p.order.chainId, "tx", txHash) }),
      events: p.events,
    };
    if (q.status === "failed") {
      const r = reject("HSP_ERROR", "hsp", "HSP가 결제 실패를 알림");
      const next_action = "HSP가 결제를 실패 처리했다. 같은 주문은 다시 결제하지 말고 판매자에게 새 주문을 요청한다";
      this.d.history.append({ ...common, status: "failed", code: r.code, step: r.step, reason: r.reason, next_action });
      return { ...r, next_action };
    }
    const finalized = q.status === "payment-finalized";
    this.d.history.append({ ...common, status: finalized ? "paid" : "confirming" });
    if (finalized && p.base.task_id) this.d.tasks?.update(p.base.task_id, { status: "paid" }, this.now());
    return {
      ok: true,
      order_ref: p.orderRef,
      payment_id: p.paymentId,
      hsp_status: q.status,
      ...(txHash && { tx_hash: txHash }),
      amount: p.base.amount,
      token: "USDC",
      pay_to: p.order.payTo,
      seller: p.base.seller,
      chain_id: p.order.chainId,
      evidence: { order_hash: p.v.orderHash, typed_data_hash: p.v.typedDataHash },
      next_action: finalized
        ? "판매자에게 order_ref와 payment_id를 보내 납품을 요청한다"
        : "결제가 아직 확정 전이다 (확인 중). 같은 주문을 다시 결제하지 말고, 잠시 뒤 check_payment로 확정을 확인한 다음 납품을 요청한다",
      ...(this.d.hspMode === "mock" && { note: "HSP mock 결제: 실제 돈은 움직이지 않았고 tx_hash는 가짜다" }),
    };
  }

  /** 제출·조회가 끊김: 돈이 나갔는지 모른다 → confirming으로 남기고 이어서 확인하게 한다 */
  private unconfirmed(p: PendingPayment, why: string, subTx?: string): Rejection {
    this.d.history.append({
      id: p.id,
      at: this.now(),
      order_ref: p.orderRef,
      kind: "payment",
      status: "confirming",
      ...p.base,
      from: p.agent,
      payment_id: p.paymentId,
      ...(subTx && { tx_hash: subTx }),
      ...(this.d.hspMode === "mock" && { simulated: true }),
      events: p.events,
      code: "PAYMENT_UNCONFIRMED",
      reason: why.slice(0, 300),
    });
    return { ...reject("PAYMENT_UNCONFIRMED", "hsp", why.slice(0, 300)) };
  }

  /**
   * 확인 중인 결제를 다시 조회한다 (에이전트 check_payment, 내역 조회 때).
   * 같은 주문을 다시 서명하지 않는다: 이미 받은 payment_id로 HSP에 묻기만 한다.
   */
  async checkPayment(orderRef: string, who: string | Caller = "local"): Promise<PayResult | { ok: false; code: "INVALID_INPUT"; reason: string }> {
    const c: Caller = typeof who === "string" ? { name: who } : who;
    const entry = this.d.history
      .list(500)
      .find((e) => e.order_ref === orderRef && !!e.payment_id && e.kind !== "withdraw" && this.mine(e, c));
    if (!entry || !entry.payment_id) return { ok: false, code: "INVALID_INPUT", reason: "이 주문의 결제 기록이 없음" };
    if (entry.status !== "confirming") {
      return entry.status === "paid"
        ? { ok: true, order_ref: orderRef, payment_id: entry.payment_id, hsp_status: (entry.hsp_status ?? "payment-finalized") as QueryResult["status"], ...(entry.tx_hash && { tx_hash: entry.tx_hash }), amount: entry.amount ?? "", token: "USDC", pay_to: entry.pay_to ?? "", seller: entry.seller ?? "", chain_id: entry.chain_id ?? 0, evidence: { order_hash: (entry.order_hash ?? "0x") as Hex, typed_data_hash: (entry.typed_data_hash ?? "0x") as Hex }, next_action: "이미 확정된 결제다. 판매자에게 납품을 요청한다" }
        : { ok: false, code: "INVALID_INPUT", reason: `이미 끝난 결제 (${entry.status})` };
    }
    let q: QueryResult;
    try {
      q = await this.d.hsp.queryPayment(entry.payment_id);
    } catch (e) {
      return reject("PAYMENT_UNCONFIRMED", "hsp", hspRejection("query", e).reason);
    }
    if (!entry.events?.some((x) => x.stage === q.status)) entry.events = [...(entry.events ?? []), { stage: q.status, at: this.now() }];
    const { id, payment_id, ...rest } = entry;
    return this.settle(
      {
        id,
        orderRef,
        paymentId: payment_id,
        base: rest as PendingPayment["base"],
        events: entry.events ?? [],
        agent: (entry.from ?? "0x") as Address,
        order: { orderRef, payTo: (entry.pay_to ?? "0x") as Address, amount: 0n, chainId: entry.chain_id ?? 0, token: "0x" as Address, expiresAt: 0 },
        v: { orderHash: (entry.order_hash ?? "0x") as Hex, typedDataHash: (entry.typed_data_hash ?? "0x") as Hex },
      },
      q,
      entry.tx_hash,
    );
  }

  /** 이 에이전트의 내역인지 (원격 연결 id, 로컬은 "local") */
  private mine(e: HistoryEntry, c: Caller): boolean {
    const me = c.id ?? "local";
    return (e.agent_id ?? "local") === me;
  }

  private extras(orderRef: string, taskId: string | undefined, agentId: string | undefined): CheckExtras {
    return {
      approval: this.d.approvals?.approvalFor(orderRef, agentId ?? "local"),
      task: this.d.tasks?.extraFor(taskId, agentId ?? "local"),
    };
  }

  /** 처음 보는 판매자 등: 주인 앱에 구매 요청을 만들고(이미 있으면 그대로) 에이전트에게 기다리라고 알린다 */
  private needsApproval(
    id: string,
    orderRef: string,
    r: Rejection,
    intent: IntentInfo,
    order: Order,
    ctx: CheckCtx,
  ): Rejection {
    const store = this.d.approvals;
    if (!store) return this.rejected(id, orderRef, r, intent, order, ctx);
    const existing = store.forOrder(orderRef, ctx.callerId ?? "local");
    if (existing?.status === "rejected") {
      return this.rejected(id, orderRef, { ...reject("OWNER_REJECTED", "policy", "주인이 이 주문을 거절함"), request_id: existing.id }, intent, order, ctx);
    }
    const req =
      existing ??
      store.ensure({
        order,
        reason: /모든 결제/.test(r.reason) ? "every_payment" : "unknown_seller",
        seller: intent.seller ?? "?",
        purpose: intent.purpose ?? "",
        ...(intent.task_id && { taskId: intent.task_id }),
        agent: ctx.caller,
        ...(ctx.callerId && { agentId: ctx.callerId }),
        now: this.now(),
      });
    return this.rejected(id, orderRef, { ...r, request_id: req.id }, intent, order, ctx);
  }

  /** 에이전트용: 주인이 맡긴 일 하나를 받아 간다 (가장 오래된 대기 일) */
  nextTask(who: string | Caller = "local"): { task: Pick<Task, "id" | "text" | "max_amount"> | null; how_to?: string } {
    const c: Caller = typeof who === "string" ? { name: who } : who;
    const store = this.d.tasks;
    const t = store?.nextOpen(c.id ?? "local");
    if (!store || !t) return { task: null };
    store.update(t.id, { status: "working", agent: c.name }, this.now());
    return {
      task: { id: t.id, text: t.text, max_amount: t.max_amount },
      how_to: `When paying for this task, call pay_order with intent.task_id="${t.id}". The wallet caps it at ${t.max_amount} USDC no matter what you or a seller says. Call finish_task when done.`,
    };
  }

  /** 에이전트용: 맡긴 일 결과 보고. 상태 말고는 아무것도 바꾸지 못한다 */
  finishTask(taskId: string, status: "done" | "failed", note: string, who: string | Caller = "local") {
    const c: Caller = typeof who === "string" ? { name: who } : who;
    const caller = c.name;
    const store = this.d.tasks;
    const t = store?.get(taskId);
    if (!store || !t || (t.agent_id && t.agent_id !== (c.id ?? "local"))) {
      return reject("INVALID_INPUT", "input", `맡긴 일 ${taskId}이 없음`);
    }
    if (t.status === "cancelled") return reject("INVALID_INPUT", "input", "주인이 그만둔 일");
    const next = store.update(taskId, { status, note: note.slice(0, 1000), agent: caller }, this.now())!;
    return { ok: true as const, task: { id: next.id, status: next.status } };
  }

  private pol(): Policy {
    return resolvePolicy(this.d.policy);
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
    const { caller: _c, callerId: _i, ...rest } = ctx;
    return describeChecks({ now: this.now(), ...rest });
  }

  private rejected(
    id: string,
    orderRef: string,
    r: Rejection,
    intent: IntentInfo = {},
    order?: Order,
    ctx?: CheckCtx,
  ): Rejection {
    this.d.history.append({
      id,
      at: this.now(),
      order_ref: orderRef,
      status: r.code === "NEEDS_OWNER_APPROVAL" ? "pending" : "rejected",
      ...intent,
      ...(ctx && { agent: ctx.caller }),
      ...(ctx?.callerId && { agent_id: ctx.callerId }),
      ...(r.request_id && { request_id: r.request_id }),
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

export interface Caller {
  name: string;
  /** 원격 연결 id */
  id?: string;
  paused?: () => boolean;
}

interface PendingPayment {
  id: string;
  orderRef: string;
  paymentId: string;
  base: Omit<HistoryEntry, "id" | "at" | "order_ref" | "status"> & { seller: string; purpose: string; amount: string; task_id?: string };
  events: { stage: string; at: number }[];
  agent: Address;
  order: Order;
  v: { orderHash: Hex; typedDataHash: Hex };
}

type IntentInfo = { seller?: string; purpose?: string; task_id?: string };

interface CheckCtx {
  intent: unknown;
  policy: Policy;
  caller: string;
  callerId?: string;
  approved?: boolean;
  agent?: Address;
  order?: Order;
  td?: TwaTypedData;
}

function intentFields(intent: unknown): IntentInfo {
  if (!intent || typeof intent !== "object") return {};
  const o = intent as Record<string, unknown>;
  return {
    ...(typeof o.seller === "string" && { seller: o.seller.slice(0, 64) }),
    ...(typeof o.purpose === "string" && { purpose: o.purpose.slice(0, 200) }),
    ...(typeof o.task_id === "string" && { task_id: o.task_id.slice(0, 64) }),
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
