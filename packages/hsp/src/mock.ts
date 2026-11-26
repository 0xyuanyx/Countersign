import { randomBytes } from "node:crypto";
import { keccak256, recoverTypedDataAddress, stringToHex, type Hex } from "viem";
import {
  HspError,
  type ChainConfig,
  type CreateOrderInput,
  type HspClient,
  type PaymentStatus,
  type PrepareResult,
  type QueryResult,
  type RawOrder,
  type RawTypedData,
} from "./types.js";

/**
 * HSP 공식 MCP의 로컬 mock. 공개 문서에 적힌 흐름(§4.1)만 흉내 낸다.
 * 실제 HSP 형식을 대신하지 않는다: README에서는 mock 결과를 VERIFIED로 쓰지 않는다.
 *
 * tamperPrepare: 악성/고장 난 prepare_payment를 흉내 낸다 (레드팀·변조 테스트용).
 */
export interface MockHspOptions {
  chainId: number;
  token: `0x${string}`;
  tokenName?: string;
  tokenVersion?: string;
  now?: () => number;
  /** 서명 유효 시간 (초). validBefore = min(주문 만료, now + 이 값) */
  authorizationTtl?: number;
  tamperPrepare?: (td: RawTypedData, order: RawOrder) => RawTypedData;
}

interface Prepared {
  typedData: RawTypedData;
  payer: string;
}

interface Payment {
  id: string;
  orderRef: string;
  polls: number;
  submitted: boolean;
  txHash: Hex;
}

const TWA_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export class MockHsp implements HspClient {
  private readonly orders = new Map<string, RawOrder>();
  private readonly prepared = new Map<string, Prepared>();
  /** order_ref → 마지막으로 finalize된 서명의 validBefore (30043 흉내) */
  private readonly lastSigned = new Map<string, number>();
  private readonly payments = new Map<string, Payment>();
  private seq = 0;
  private readonly runId = randomBytes(3).toString("hex");
  private readonly now: () => number;

  constructor(private readonly opts: MockHspOptions) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async getChainConfig(): Promise<ChainConfig> {
    // 결제 체인 + Base Sepolia (악성 판매자의 "다른 체인 주문" 데모용: HSP는 받지만 지갑 정책이 허용하지 않는 체인)
    return {
      chains: [
        { chain_id: this.opts.chainId, name: "mock", tokens: { USDC: this.opts.token } },
        ...(this.opts.chainId !== 84532 ? [{ chain_id: 84532, name: "base-sepolia", tokens: { USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" } }] : []),
      ],
    };
  }

  async createOrder(input: CreateOrderInput): Promise<RawOrder> {
    // 재시작해도 겹치지 않게 (지갑 지출 기록은 파일로 남아서, 번호만 쓰면 DUPLICATE로 오판한다)
    const ref = `mock_ord_${++this.seq}_${this.runId}`;
    const order: RawOrder = {
      order_ref: ref,
      payment_request_id: `mock_pr_${this.seq}_${this.runId}`,
      gas_fee_advanced: true,
      pay_to: input.pay_to,
      amount: input.amount,
      chain_id: input.chain_id,
      token: input.token,
      expires_at: this.now() + (input.ttl_seconds ?? 600),
      description: input.description,
      status: "created",
    };
    this.orders.set(ref, order);
    return structuredClone(order);
  }

  async getOrder(orderRef: string): Promise<RawOrder> {
    const o = this.orders.get(orderRef);
    if (!o) throw new HspError("get_order", "NOT_FOUND", `주문 없음: ${orderRef}`);
    return structuredClone(o);
  }

  async preparePayment(orderRef: string, payer: string): Promise<PrepareResult> {
    const order = await this.getOrder(orderRef);
    const prev = this.lastSigned.get(orderRef);
    if (prev !== undefined && prev > this.now()) {
      throw new HspError("prepare_payment", 30043, "이전 서명의 validBefore가 지나지 않음");
    }
    const validBefore = Math.min(order.expires_at, this.now() + (this.opts.authorizationTtl ?? 300));
    let typedData: RawTypedData = {
      domain: {
        name: this.opts.tokenName ?? "USD Coin",
        version: this.opts.tokenVersion ?? "2",
        chainId: order.chain_id,
        verifyingContract: order.token,
      },
      types: structuredClone(TWA_TYPES),
      primaryType: "TransferWithAuthorization",
      message: {
        from: payer,
        to: order.pay_to,
        value: String(order.amount),
        validAfter: "0",
        validBefore: String(validBefore),
        nonce: `0x${randomBytes(32).toString("hex")}`,
      },
    };
    if (this.opts.tamperPrepare) typedData = this.opts.tamperPrepare(typedData, order);
    this.prepared.set(orderRef, { typedData, payer });
    // 공식 가이드 §7의 prepare_payment 반환 필드를 흉내 낸다 (finalize 값 세 개는 불투명 값)
    const payment_payload = { flow_id: orderRef, payload: { signature: "" } };
    return {
      order_ref: orderRef,
      typed_data: structuredClone(typedData),
      token_total_raw: String((typedData.message as Record<string, unknown>).value),
      quote_expires_at: new Date((this.now() + 300) * 1000).toISOString(),
      pay_to: order.pay_to,
      payer,
      ...(order.payment_request_id && { payment_request_id: order.payment_request_id }),
      payment_payload,
      finalize: {
        payment_payload,
        payment_mandate_contents: { flow_id: orderRef, payment_request_id: order.payment_request_id },
        cart_hash: keccak256(stringToHex(`cart:${orderRef}`)).slice(2),
      },
    };
  }

  async finalizePayment(orderRef: string, signature: string, _prepared?: PrepareResult): Promise<{ payment_id: string; payment_mandate_json?: unknown }> {
    const p = this.prepared.get(orderRef);
    if (!p) throw new HspError("finalize_payment", "NOT_PREPARED", "prepare_payment 먼저");
    const order = this.orders.get(orderRef)!;
    if (order.status === "paid") throw new HspError("finalize_payment", "ALREADY_PAID", "이미 결제된 주문");
    const m = p.typedData.message as Record<string, string>;
    const validBefore = Number(m.validBefore);
    if (validBefore <= this.now()) throw new HspError("finalize_payment", "EXPIRED", "서명 만료");
    // mock은 자기가 만든 typed data를 그대로 검증한다
    const recovered = await recoverTypedDataAddress({
      domain: p.typedData.domain,
      types: p.typedData.types,
      primaryType: p.typedData.primaryType,
      message: m,
      signature: signature as Hex,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    if (recovered.toLowerCase() !== String(m.from).toLowerCase()) {
      throw new HspError("finalize_payment", "BAD_SIGNATURE", "서명자 불일치");
    }
    this.lastSigned.set(orderRef, validBefore);
    order.status = "paid";
    // 결제 id = 주문의 payment_request_id (가이드: create_order가 준 값으로 조회·복구)
    const id = order.payment_request_id ?? `mock_pr_x_${this.runId}`;
    this.payments.set(id, { id, orderRef, polls: 0, submitted: false, txHash: keccak256(stringToHex(`${id}:${signature}`)) });
    return { payment_id: id, payment_mandate_json: { flow_id: orderRef, payment_request_id: id, mandate: "mock-jwt" } };
  }

  async estimateFee(_orderRef: string): Promise<unknown> {
    return { fee: "0", payer_gas: "0" };
  }

  async submitPayment(paymentId: string, mandate?: unknown): Promise<{ payment_id: string; tx_hash?: string }> {
    const p = this.mustPayment("submit_payment", paymentId);
    const m = mandate as { payment_request_id?: string } | undefined;
    if (m && m.payment_request_id !== paymentId) throw new HspError("submit_payment", "BAD_MANDATE", "다른 결제의 payment_mandate_json");
    p.submitted = true;
    return { payment_id: p.id, tx_hash: p.txHash };
  }

  async queryPayment(paymentId: string, orderRef?: string): Promise<QueryResult> {
    const p = this.payments.get(paymentId) ?? [...this.payments.values()].find((x) => x.orderRef === orderRef);
    if (!p) throw new HspError("query_payment", "NOT_FOUND", `결제 없음: ${paymentId}`);
    if (orderRef && p.orderRef !== orderRef) throw new HspError("query_payment", "NOT_FOUND", "flow_id와 결제가 맞지 않음");
    let status: PaymentStatus = "pending";
    let hsp = "payment-pending";
    if (p.submitted) {
      p.polls++;
      [status, hsp] =
        p.polls === 1 ? ["submitted", "payment-included"] : p.polls === 2 ? ["payment-safe", "payment-safe"] : ["payment-finalized", "payment-finalized"];
    }
    return {
      payment_id: p.id,
      order_ref: p.orderRef,
      status,
      hsp_status: hsp,
      attribution_verified: true,
      tx_hash: p.submitted ? p.txHash : undefined,
      chain_id: this.opts.chainId,
    };
  }

  private mustPayment(tool: "submit_payment" | "query_payment", id: string): Payment {
    const p = this.payments.get(id);
    if (!p) throw new HspError(tool, "NOT_FOUND", `결제 없음: ${id}`);
    return p;
  }
}
