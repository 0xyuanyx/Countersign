import type { RawTypedData } from "@ouryn/hsp";
import { describe, expect, it } from "vitest";
import { checkSignature, parseTypedData, verifyPayment, type VerifiedPayment } from "./evidence.js";
import type { Order } from "./order.js";
import { EVIL, NOW, agent, intent, policy, setup, stranger } from "./testkit.js";

type Msg = Record<string, unknown>;
const withMsg = (patch: Msg) => (td: RawTypedData): RawTypedData => ({ ...td, message: { ...td.message, ...patch } });
const withDomain = (patch: Partial<RawTypedData["domain"]>) => (td: RawTypedData): RawTypedData => ({
  ...td,
  domain: { ...td.domain, ...patch },
});

async function verify(
  opts: Parameters<typeof setup>[0] = {},
  over: { order?: Partial<Order>; now?: number; markPaid?: boolean } = {},
) {
  const s = await setup(opts);
  const order = { ...s.order, ...over.order };
  if (over.markPaid) s.ledger.record(order.orderRef, order.amount, NOW - 10);
  return verifyPayment({
    order,
    intent,
    policy,
    ledger: s.ledger,
    typedData: s.typedData,
    agent: agent.address,
    now: over.now ?? NOW,
  });
}

describe("verifyPayment 정상", () => {
  it("mock HSP 주문 + prepare 결과가 통과하고, 서명자 복원이 맞는다", async () => {
    const r = await verify();
    expect(r.ok).toBe(true);
    const v = r as VerifiedPayment;
    expect(v.typedDataHash).toMatch(/^0x[0-9a-f]{64}$/);
    const sig = await agent.signTypedData({
      domain: v.td.domain,
      types: { TransferWithAuthorization: [...(await import("./evidence.js")).TWA_FIELDS] },
      primaryType: "TransferWithAuthorization",
      message: v.td.message,
    });
    expect((await checkSignature(v.td, sig, agent.address)).ok).toBe(true);
  });
});

// AGENTS.md: 변조 케이스 (수취인, 금액, 체인, 토큰, 만료, 서명자 바꿔치기) + 중복 결제
describe("변조 1. 수취인", () => {
  it("prepare_payment가 to를 바꿔치기", async () => {
    expect(await verify({ tamper: withMsg({ to: EVIL }) })).toMatchObject({ code: "TYPED_DATA_MISMATCH", step: "typed_data" });
  });
  it("악성 판매자가 주문 pay_to 자체를 다른 주소로", async () => {
    expect(await verify({ payTo: EVIL })).toMatchObject({ code: "PAYEE_MISMATCH", step: "policy" });
  });
});

describe("변조 2. 금액", () => {
  it("prepare_payment가 value를 1 올림", async () => {
    expect(await verify({ tamper: withMsg({ value: "100001" }) })).toMatchObject({ code: "TYPED_DATA_MISMATCH" });
  });
  it("value를 hex로 같은 값이면 통과 (형식이 아니라 값으로 비교)", async () => {
    expect((await verify({ tamper: withMsg({ value: "0x186a0" }) })).ok).toBe(true);
  });
  it("주문 금액이 의도 상한 초과", async () => {
    expect(await verify({ amount: "300000" })).toMatchObject({ code: "AMOUNT_OVER_INTENT" });
  });
});

describe("변조 3. 체인", () => {
  it("domain.chainId를 메인넷 177로 바꿔치기", async () => {
    expect(await verify({ tamper: withDomain({ chainId: 177 }) })).toMatchObject({ code: "TYPED_DATA_MISMATCH" });
  });
  it("주문 체인이 정책에 없음", async () => {
    expect(await verify({}, { order: { chainId: 1 } })).toMatchObject({ code: "CHAIN_OR_TOKEN_NOT_ALLOWED" });
  });
});

describe("변조 4. 토큰", () => {
  it("verifyingContract를 다른 토큰으로", async () => {
    expect(await verify({ tamper: withDomain({ verifyingContract: EVIL }) })).toMatchObject({
      code: "TYPED_DATA_MISMATCH",
    });
  });
  it("주문 토큰이 허용 USDC가 아님", async () => {
    expect(await verify({}, { order: { token: EVIL } })).toMatchObject({ code: "CHAIN_OR_TOKEN_NOT_ALLOWED" });
  });
});

describe("변조 5. 만료", () => {
  it("주문 만료 후", async () => {
    expect(await verify({}, { now: NOW + 601 })).toMatchObject({ code: "EXPIRED", step: "policy" });
  });
  it("validBefore가 이미 지남", async () => {
    expect(await verify({ tamper: withMsg({ validBefore: String(NOW) }) })).toMatchObject({
      code: "EXPIRED",
      step: "typed_data",
    });
  });
  it("validBefore를 아주 먼 미래로 (오래 살아 있는 서명)", async () => {
    expect(await verify({ tamper: withMsg({ validBefore: String(NOW + 10 * 86400) }) })).toMatchObject({
      code: "TYPED_DATA_MISMATCH",
    });
  });
  it("validAfter가 미래", async () => {
    expect(await verify({ tamper: withMsg({ validAfter: String(NOW + 60) }) })).toMatchObject({
      code: "TYPED_DATA_MISMATCH",
    });
  });
});

describe("변조 6. 서명자", () => {
  it("from을 다른 계정으로 (남의 돈으로 서명시키기)", async () => {
    expect(await verify({ tamper: withMsg({ from: stranger.address }) })).toMatchObject({ code: "TYPED_DATA_MISMATCH" });
  });
  it("다른 키로 만든 서명은 서명자 복원에서 거부", async () => {
    const v = (await verify()) as VerifiedPayment;
    const { TWA_FIELDS } = await import("./evidence.js");
    const sig = await stranger.signTypedData({
      domain: v.td.domain,
      types: { TransferWithAuthorization: [...TWA_FIELDS] },
      primaryType: "TransferWithAuthorization",
      message: v.td.message,
    });
    expect(await checkSignature(v.td, sig, agent.address)).toMatchObject({ code: "SIGNATURE_INVALID" });
    expect(await checkSignature(v.td, "0x1234", agent.address)).toMatchObject({ code: "SIGNATURE_INVALID" });
  });
});

describe("변조 7. 중복 결제", () => {
  it("이미 결제한 주문", async () => {
    expect(await verify({}, { markPaid: true })).toMatchObject({ code: "DUPLICATE" });
  });
});

describe("변조 기타: 서명 형식 바꿔치기", () => {
  it("primaryType을 Permit으로", async () => {
    expect(await verify({ tamper: (td) => ({ ...td, primaryType: "Permit" }) })).toMatchObject({
      code: "TYPED_DATA_MISMATCH",
    });
  });
  it("types에 다른 타입을 끼워 넣음", async () => {
    const r = await verify({
      tamper: (td) => ({ ...td, types: { ...td.types, Mail: [{ name: "x", type: "string" }] } }),
    });
    expect(r).toMatchObject({ code: "TYPED_DATA_MISMATCH" });
  });
  it("TWA 필드 순서를 바꿈", async () => {
    const r = await verify({
      tamper: (td) => ({
        ...td,
        types: { ...td.types, TransferWithAuthorization: [...td.types.TransferWithAuthorization!].reverse() },
      }),
    });
    expect(r).toMatchObject({ code: "TYPED_DATA_MISMATCH" });
  });
  it("message에 필드 추가", async () => {
    expect(await verify({ tamper: withMsg({ memo: "x" }) })).toMatchObject({ code: "TYPED_DATA_MISMATCH" });
  });
  it("EIP712Domain 정의가 domain과 다름", async () => {
    const r = await verify({
      tamper: (td) => ({ ...td, types: { ...td.types, EIP712Domain: [{ name: "name", type: "string" }] } }),
    });
    expect(r).toMatchObject({ code: "TYPED_DATA_MISMATCH" });
  });
  it("nonce가 bytes32가 아님", async () => {
    expect(await verify({ tamper: withMsg({ nonce: "0x01" }) })).toMatchObject({ code: "TYPED_DATA_MISMATCH" });
  });
  it("쓰레기 입력", () => {
    expect(parseTypedData(null)).toMatchObject({ code: "TYPED_DATA_MISMATCH" });
    expect(parseTypedData("sign me")).toMatchObject({ code: "TYPED_DATA_MISMATCH" });
  });
});
