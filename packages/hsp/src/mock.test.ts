import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { loadHspConfig } from "./config.js";
import { createHspClient } from "./index.js";
import { MockHsp } from "./mock.js";
import { HspError } from "./types.js";

const NOW = 1_800_000_000;
// 테스트 전용 키 (공개된 Foundry anvil 0번 키, 실제 자금 없음)
const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const TOKEN = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6";
const SELLER = "0x00000000000000000000000000000000000000a1";

async function signPrepared(hsp: MockHsp, ref: string) {
  const p = await hsp.preparePayment(ref, payer.address);
  const td = p.typed_data;
  const { EIP712Domain: _d, ...types } = td.types;
  return payer.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message } as never);
}

describe("MockHsp 흐름 (§4.1)", () => {
  it("create → get → prepare → (서명) → finalize → submit → query", async () => {
    const hsp = new MockHsp({ chainId: 133, token: TOKEN, now: () => NOW });
    const o = await hsp.createOrder({ pay_to: SELLER, amount: "100000", chain_id: 133, token: TOKEN });
    expect(await hsp.getOrder(o.order_ref)).toMatchObject({ pay_to: SELLER, amount: "100000", expires_at: NOW + 600 });
    const sig = await signPrepared(hsp, o.order_ref);
    const { payment_id } = await hsp.finalizePayment(o.order_ref, sig);
    expect((await hsp.queryPayment(payment_id)).status).toBe("pending");
    const sub = await hsp.submitPayment(payment_id);
    expect(sub.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push((await hsp.queryPayment(payment_id)).status);
    expect(seen).toEqual(["submitted", "payment-safe", "payment-finalized"]);
  });

  it("validBefore가 지나기 전 재prepare는 30043, 이미 결제한 주문은 거부", async () => {
    let now = NOW;
    const hsp = new MockHsp({ chainId: 133, token: TOKEN, now: () => now });
    const o = await hsp.createOrder({ pay_to: SELLER, amount: "1", chain_id: 133, token: TOKEN });
    await hsp.finalizePayment(o.order_ref, await signPrepared(hsp, o.order_ref));
    await expect(hsp.preparePayment(o.order_ref, payer.address)).rejects.toMatchObject({ hspCode: 30043 });
    now += 301;
    const sig = await signPrepared(hsp, o.order_ref);
    await expect(hsp.finalizePayment(o.order_ref, sig)).rejects.toBeInstanceOf(HspError);
  });

  it("다른 키 서명은 finalize에서 거부", async () => {
    const hsp = new MockHsp({ chainId: 133, token: TOKEN, now: () => NOW });
    const o = await hsp.createOrder({ pay_to: SELLER, amount: "1", chain_id: 133, token: TOKEN });
    const td = (await hsp.preparePayment(o.order_ref, payer.address)).typed_data;
    const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const { EIP712Domain: _d, ...types } = td.types;
    const sig = await other.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message } as never);
    await expect(hsp.finalizePayment(o.order_ref, sig)).rejects.toMatchObject({ hspCode: "BAD_SIGNATURE" });
  });
});

describe("설정값", () => {
  it("기본은 mock + Ethereum Sepolia (운영진 11/26 안내)", () => {
    expect(loadHspConfig({})).toEqual({ mode: "mock", payChainId: 11155111 });
  });
  it("결제 체인은 환경변수로 바꾼다", () => {
    expect(loadHspConfig({ COUNTERSIGN_PAY_CHAIN_ID: "177" })).toEqual({ mode: "mock", payChainId: 177 });
  });
  it("mcp 모드는 https 주소·체인·팀 이름(merchant_name)을 반드시 받는다", () => {
    const qa = { COUNTERSIGN_HSP_MODE: "mcp", COUNTERSIGN_HSP_MCP_URL: "https://mcp-qa.hashkeymerchant.com/", COUNTERSIGN_PAY_CHAIN_ID: "11155111" };
    expect(() => loadHspConfig({ COUNTERSIGN_HSP_MODE: "mcp" })).toThrow();
    expect(() => loadHspConfig({ ...qa, COUNTERSIGN_HSP_MCP_URL: "http://x.test" })).toThrow();
    expect(() => loadHspConfig(qa)).toThrow(); // 팀 이름 없음
    expect(loadHspConfig({ ...qa, COUNTERSIGN_HSP_MERCHANT_NAME: "Countersign" })).toMatchObject({ mode: "mcp", payChainId: 11155111, merchantName: "Countersign" });
  });
  it("mock은 USDC 주소를 모르는 체인이면 만들지 않는다", async () => {
    await expect(createHspClient({ mode: "mock", payChainId: 84532 })).rejects.toThrow();
  });
});
