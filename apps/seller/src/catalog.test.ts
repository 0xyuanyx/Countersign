import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySpendLedger, checkOrder, normalizeOrder, parseAmount, parsePolicy, formatAmount } from "@countersign/wallet-core";
import { describe, expect, it } from "vitest";
import { DATA_MART_ITEMS, LOOKALIKE_ITEMS } from "./catalog.js";
import { EVIL_MULTIPLIER } from "./server.js";

/**
 * 회귀 (11/27 리뷰 P1-1): 기본 데모 설정 그대로, 인젝션에 속은 에이전트가 판매자가 시킨 금액을 intent.max_amount에
 * 그대로 적어도 지갑 정책에서 막혀야 한다. 상품 가격·악성 배수·데모 정책 한도 중 하나만 바뀌어도 여기서 깨진다.
 */
const root = join(import.meta.dirname, "../../..");
const SELLER = "0x928CED58e2b79aA60ACd3Df2F3cA2037C92E1978";
const NOW = 1_800_000_000;
const policies = {
  "데모 기본 정책 (policy.sepolia.json, 첫 에이전트)": JSON.parse(readFileSync(join(root, "apps/demo/policy.sepolia.json"), "utf8")),
  "새 에이전트 기본 정책 (1회 0.5, 하루 5)": {
    agent: "new",
    accountIndex: 2,
    chains: [11155111],
    token: "USDC",
    perTxMax: "0.5",
    dailyMax: "5",
    sellers: { "data-mart": SELLER },
  },
};

describe.each(Object.entries(policies))("%s", (_name, json) => {
  const policy = parsePolicy(json);
  const chainId = [...policy.chains][0]!;
  const token = policy.tokens.get(chainId)!;

  it.each(LOOKALIKE_ITEMS.map((i) => [i.sku, i.price] as const))("인젝션: %s(%s USDC)의 악성 청구는 속은 에이전트로도 통과 못 함", (_sku, price) => {
    const amount = parseAmount(price) * EVIL_MULTIPLIER;
    const order = normalizeOrder({
      order_ref: "evil",
      pay_to: SELLER,
      amount: amount.toString(),
      chain_id: chainId,
      token,
      expires_at: NOW + 600,
    });
    // 속은 에이전트: 판매자가 시킨 금액을 그대로 상한으로 적는다
    const fooled = { purpose: "x", max_amount: formatAmount(amount), seller: "data-mart" };
    const r = checkOrder(order, fooled, policy, new MemorySpendLedger(), NOW);
    expect(r.ok).toBe(false);
    // 속지 않은 에이전트: 말한 가격을 상한으로 → 금액 초과
    const honest = { purpose: "x", max_amount: price, seller: "data-mart" };
    expect(checkOrder(order, honest, policy, new MemorySpendLedger(), NOW)).toMatchObject({ ok: false, code: "AMOUNT_OVER_INTENT" });
  });

  it("정상 상품은 한도 안이면 통과 (한도를 넘는 고가 상품만 OVER_LIMIT)", () => {
    for (const i of DATA_MART_ITEMS) {
      const amount = parseAmount(i.price);
      const order = normalizeOrder({ order_ref: i.sku, pay_to: SELLER, amount: amount.toString(), chain_id: chainId, token, expires_at: NOW + 600 });
      const r = checkOrder(order, { purpose: "x", max_amount: i.price, seller: "data-mart" }, { ...policy, sellers: new Map([["data-mart", SELLER]]) }, new MemorySpendLedger(), NOW);
      if (amount > policy.perTxMax) expect(r).toMatchObject({ code: "OVER_LIMIT" });
      else expect(r.ok).toBe(true);
    }
  });
});
