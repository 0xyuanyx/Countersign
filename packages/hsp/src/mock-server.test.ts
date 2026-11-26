import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadHspConfig } from "./config.js";
import { McpHspClient } from "./mcp-client.js";
import { serveMockHsp, type MockHspServer } from "./mock-server.js";
import { HspError } from "./types.js";

// 공개된 anvil 0번 테스트 키 (실제 자금 없음)
const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const TOKEN = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6";
const SELLER = "0x00000000000000000000000000000000000000a1";

let srv: MockHspServer;
let client: McpHspClient;
beforeAll(async () => {
  srv = await serveMockHsp({ chainId: 133, token: TOKEN, merchantName: "team-x" });
  client = new McpHspClient(srv.url, { merchantName: "team-x" });
  await client.connect();
});
afterAll(async () => {
  await client.close();
  await srv.close();
});

describe("HSP mock MCP 서버 ↔ McpHspClient", () => {
  it("공식 가이드 순서·인자 이름으로 주문 → prepare → finalize → submit → query 완료까지 간다", async () => {
    const o = await client.createOrder({ pay_to: SELLER, amount: "100000", chain_id: 133, token: TOKEN });
    expect(o.order_ref).toMatch(/^mock_ord_/); // flow_id
    expect(o.payment_request_id).toMatch(/^mock_pr_/);
    expect(await client.getOrder(o.order_ref)).toMatchObject({ pay_to: SELLER, amount: "100000", gas_fee_advanced: true });
    const p = await client.preparePayment(o.order_ref, payer.address, "eip3009");
    expect(p).toMatchObject({ token_total_raw: "100000", pay_to: SELLER, payer: payer.address, payment_request_id: o.payment_request_id });
    expect(p.finalize?.cart_hash).toMatch(/^[0-9a-f]{64}$/);
    const { EIP712Domain: _d, ...types } = p.typed_data.types;
    const sig = await payer.signTypedData({ ...p.typed_data, types } as never);
    const fin = await client.finalizePayment(o.order_ref, sig, p);
    expect(fin.payment_id).toBe(o.payment_request_id);
    expect(fin.payment_mandate_json).toBeTruthy();
    await client.submitPayment(fin.payment_id, fin.payment_mandate_json);
    let q = await client.queryPayment(fin.payment_id, o.order_ref);
    expect(q).toMatchObject({ hsp_status: "payment-included", status: "submitted", attribution_verified: true });
    while (q.status !== "payment-finalized") q = await client.queryPayment(fin.payment_id, o.order_ref);
    expect(q).toMatchObject({ order_ref: o.order_ref, tx_hash: expect.stringMatching(/^0x/) });
    // 다른 팀 이름으로 조회하면 귀속 확인이 false
    const other = new McpHspClient(srv.url, { merchantName: "someone-else" });
    await other.connect();
    expect((await other.queryPayment(fin.payment_id, o.order_ref)).attribution_verified).toBe(false);
    await other.close();
  });

  it("get_chain_config에 없는 체인·토큰으로는 주문을 만들지 않는다", async () => {
    await expect(client.createOrder({ pay_to: SELLER, amount: "1", chain_id: 84532, token: TOKEN })).rejects.toMatchObject({ hspCode: "UNSUPPORTED" });
  });

  it("HSP 오류는 HspError로, 5자리 코드는 숫자로 온다", async () => {
    await expect(client.getOrder("nope")).rejects.toBeInstanceOf(HspError);
    const o = await client.createOrder({ pay_to: SELLER, amount: "1", chain_id: 133, token: TOKEN });
    const p = await client.preparePayment(o.order_ref, payer.address);
    const { EIP712Domain: _d, ...types } = p.typed_data.types;
    await client.finalizePayment(o.order_ref, await payer.signTypedData({ ...p.typed_data, types } as never), p);
    await expect(client.preparePayment(o.order_ref, payer.address)).rejects.toMatchObject({ hspCode: 30043 });
  });

  it("http는 루프백 mock 주소만 허용한다", () => {
    expect(() => new McpHspClient("http://example.com/mcp")).toThrow();
    expect(() => loadHspConfig({ COUNTERSIGN_HSP_MODE: "mcp", COUNTERSIGN_HSP_MCP_URL: "http://10.0.0.1/", COUNTERSIGN_PAY_CHAIN_ID: "133" })).toThrow();
    expect(() => loadHspConfig({ COUNTERSIGN_HSP_MODE: "mcp", COUNTERSIGN_HSP_MCP_URL: srv.url, COUNTERSIGN_PAY_CHAIN_ID: "133" })).toThrow();
    expect(loadHspConfig({ COUNTERSIGN_HSP_MODE: "mock", COUNTERSIGN_HSP_MCP_URL: srv.url })).toMatchObject({ mode: "mock", mcpUrl: srv.url });
    expect(() => loadHspConfig({ COUNTERSIGN_HSP_MODE: "mock", COUNTERSIGN_HSP_MCP_URL: "https://mcp-qa.hashkeymerchant.com/" })).toThrow();
  });
});
