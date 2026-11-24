// 테스트 전용 고정값. 공개 BIP-39 테스트 니모닉만 쓴다 (실제 키 아님).
import { KNOWN_USDC, MockHsp, type RawTypedData } from "@ouryn/hsp";
import { deriveAccount } from "./keys.js";
import { normalizeOrder, type Order } from "./order.js";
import { MemorySpendLedger, parsePolicy } from "./policy.js";

export const TEST_WORDS =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const NOW = 1_800_000_000;
export const agent = deriveAccount(TEST_WORDS, 1);
export const stranger = deriveAccount(TEST_WORDS, 9);
export const SELLER = deriveAccount(TEST_WORDS, 2).address;
export const EVIL = "0x000000000000000000000000000000000000dEaD" as const;
export const CHAIN = 133;
export const USDC = KNOWN_USDC[133]!;

export const policyJson = {
  agent: "buyer-1",
  accountIndex: 1,
  chains: [133],
  token: "USDC",
  perTxMax: "0.50",
  dailyMax: "1.00",
  sellers: { "profile-seller": SELLER },
};
export const policy = parsePolicy(policyJson);
export const intent = { purpose: "주소 프로필 1건", max_amount: "0.20", seller: "profile-seller" };

export async function setup(opts: { amount?: string; payTo?: string; tamper?: (td: RawTypedData) => RawTypedData } = {}) {
  const hsp = new MockHsp({
    chainId: CHAIN,
    token: USDC,
    now: () => NOW,
    tamperPrepare: opts.tamper ? (td) => opts.tamper!(td) : undefined,
  });
  const raw = await hsp.createOrder({
    pay_to: opts.payTo ?? SELLER,
    amount: opts.amount ?? "100000",
    chain_id: CHAIN,
    token: USDC,
  });
  const order: Order = normalizeOrder(await hsp.getOrder(raw.order_ref));
  const prepared = await hsp.preparePayment(order.orderRef, agent.address);
  return { hsp, order, typedData: prepared.typed_data, ledger: new MemorySpendLedger() };
}
