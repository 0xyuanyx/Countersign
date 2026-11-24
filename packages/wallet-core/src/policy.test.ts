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
  it("허용 목록 밖 판매자", () => expect(run(order(), { ...intent, seller: "x" })).toMatchObject({ code: "PAYEE_MISMATCH" }));
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
