import { describe, expect, it } from "vitest";
import { MemorySpendLedger, checkOrder, parsePolicy } from "./policy.js";
import { CHAIN, EVIL, NOW, SELLER, USDC, intent, policy, policyJson } from "./testkit.js";
import type { Order } from "./order.js";

const order = (o: Partial<Order> = {}): Order => ({
  orderRef: "o1",
  payTo: SELLER,
  amount: 100_000n,
  chainId: CHAIN,
  token: USDC,
  expiresAt: NOW + 600,
  ...o,
});
const run = (o: Order, i: unknown = intent, l = new MemorySpendLedger()) => checkOrder(o, i, policy, l, NOW);

describe("parsePolicy", () => {
  it("금액을 bigint로, 주소를 체크섬으로", () => {
    expect(policy.perTxMax).toBe(500_000n);
    expect(policy.dailyMax).toBe(1_000_000n);
    expect(policy.tokens.get(133)).toBe(USDC);
  });
  it("모르는 필드, 토큰 주소 없는 체인, perTx>daily를 거부한다", () => {
    expect(() => parsePolicy({ ...policyJson, admin: true })).toThrow();
    expect(() => parsePolicy({ ...policyJson, chains: [84532] })).toThrow(/USDC 주소/);
    expect(() => parsePolicy({ ...policyJson, perTxMax: "2" })).toThrow();
    expect(() => parsePolicy({ ...policyJson, accountIndex: 0 })).toThrow(); // 0번은 주인 계정
  });
  it("tokenAddresses로 다른 체인 USDC를 추가할 수 있다", () => {
    const p = parsePolicy({ ...policyJson, chains: [84532], tokenAddresses: { "84532": EVIL } });
    expect(p.tokens.get(84532)).toBe(EVIL);
  });
});

describe("checkOrder", () => {
  it("정상 주문 통과", () => expect(run(order()).ok).toBe(true));
  it("다른 이름이어도 등록 판매자의 주소면 그 판매자로 보고 통과", () =>
    expect(run(order(), { ...intent, seller: "x" }).ok).toBe(true));
  it("처음 보는 판매자(이름·주소 모두 미등록)는 주인 승인 대기", () =>
    expect(run(order({ payTo: EVIL }), { ...intent, seller: "x" })).toMatchObject({ code: "NEEDS_OWNER_APPROVAL" }));
  it("처음 보는 판매자라도 금액·한도 위반이 먼저 거절된다 (승인 요청까지 가지 않음)", () =>
    expect(run(order({ payTo: EVIL, amount: 600_000n }), { ...intent, seller: "x", max_amount: "1.00" })).toMatchObject({
      code: "OVER_LIMIT",
    }));
  it("주인 승인은 주문 값이 모두 같을 때만 효력", () => {
    const o = order({ payTo: EVIL });
    const approval = { orderRef: o.orderRef, payTo: EVIL, amount: o.amount, chainId: CHAIN, token: USDC };
    const ok = checkOrder(o, { ...intent, seller: "x" }, policy, new MemorySpendLedger(), NOW, { approval });
    expect(ok.ok).toBe(true);
    const other = checkOrder(order({ payTo: EVIL, amount: 100_001n }), { ...intent, seller: "x" }, policy, new MemorySpendLedger(), NOW, { approval });
    expect(other).toMatchObject({ code: "NEEDS_OWNER_APPROVAL" });
  });
  it("등록 판매자 이름 + 다른 주소는 승인이 있어도 PAYEE_MISMATCH", () => {
    const o = order({ payTo: EVIL });
    const approval = { orderRef: o.orderRef, payTo: EVIL, amount: o.amount, chainId: CHAIN, token: USDC };
    expect(checkOrder(o, intent, policy, new MemorySpendLedger(), NOW, { approval })).toMatchObject({ code: "PAYEE_MISMATCH" });
  });
  it("every_payment 모드: 등록 판매자도 승인 대기, 승인되면 통과", () => {
    const strict = { ...policy, approvalMode: "every_payment" as const };
    const o = order();
    expect(checkOrder(o, intent, strict, new MemorySpendLedger(), NOW)).toMatchObject({ code: "NEEDS_OWNER_APPROVAL" });
    const approval = { orderRef: o.orderRef, payTo: SELLER, amount: o.amount, chainId: CHAIN, token: USDC };
    expect(checkOrder(o, intent, strict, new MemorySpendLedger(), NOW, { approval }).ok).toBe(true);
  });
  it("맡긴 일: 일의 최대 금액을 넘거나 없는/끝난 일이면 거절", () => {
    const task = { id: "t1", maxAmount: 50_000n, active: true };
    const i = { ...intent, task_id: "t1" };
    expect(checkOrder(order(), i, policy, new MemorySpendLedger(), NOW, { task })).toMatchObject({ code: "AMOUNT_OVER_INTENT" });
    expect(checkOrder(order({ amount: 50_000n }), i, policy, new MemorySpendLedger(), NOW, { task }).ok).toBe(true);
    expect(checkOrder(order({ amount: 50_000n }), i, policy, new MemorySpendLedger(), NOW, { task: { ...task, active: false } })).toMatchObject({ code: "INVALID_INPUT" });
    expect(checkOrder(order({ amount: 50_000n }), i, policy, new MemorySpendLedger(), NOW)).toMatchObject({ code: "INVALID_INPUT" });
  });
  it("판매자 이름은 맞는데 주소가 다름", () => expect(run(order({ payTo: EVIL }))).toMatchObject({ code: "PAYEE_MISMATCH" }));
  it("의도 상한 초과", () => expect(run(order({ amount: 200_001n }))).toMatchObject({ code: "AMOUNT_OVER_INTENT" }));
  it("건당 상한 초과", () =>
    expect(run(order({ amount: 600_000n }), { ...intent, max_amount: "1" })).toMatchObject({ code: "OVER_LIMIT" }));
  it("일일 상한: 24시간 안의 지출을 더한다", () => {
    const l = new MemorySpendLedger();
    l.record("a", 450_000n, NOW - 100);
    l.record("b", 450_000n, NOW - 86_401); // 24시간 지난 건 빠짐
    expect(run(order({ amount: 100_000n }), intent, l).ok).toBe(true);
    l.record("c", 450_000n, NOW - 50);
    expect(run(order({ amount: 100_001n }), intent, l)).toMatchObject({ code: "OVER_LIMIT" });
  });
  it("0원 주문", () => expect(run(order({ amount: 0n }))).toMatchObject({ code: "INVALID_INPUT" }));
  it("intent 형식 오류·추가 필드", () => {
    expect(run(order(), { ...intent, max_amount: "lots" })).toMatchObject({ code: "INVALID_INPUT" });
    expect(run(order(), { ...intent, perTxMax: "100" })).toMatchObject({ code: "INVALID_INPUT" });
  });
  it("거부에는 next_action이 붙는다", () => {
    const r = run(order({ payTo: EVIL }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.next_action).toMatch(/재발급/);
  });
});
