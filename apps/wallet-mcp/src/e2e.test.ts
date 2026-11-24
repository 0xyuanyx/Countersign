import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_USDC, McpHspClient, MockHsp, serveMockHsp, type MockHspServer } from "@countersign/hsp";
import { createSeller, listenSeller, type EvilMode } from "@countersign/seller";
import { SignerClient, createSigner, listen } from "@countersign/signer";
import {
  FileSpendLedger,
  HistoryStore,
  MemorySpendLedger,
  parsePolicy,
  readPause,
  statePaths,
  writePause,
} from "@countersign/wallet-core";
import { SELLER, agent } from "@countersign/wallet-core/testkit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WalletService, type SignerPort } from "./service.js";
import { WALLET_TOOLS, registerWalletTools } from "./tools.js";

/**
 * 끝에서 끝까지: HSP mock MCP 서버 ─ 판매 서버(정상·악성 4종) ─ 지갑 MCP(키 없음) ─ signer(유닉스 소켓).
 * 구매 에이전트 자리는 MCP 클라이언트가 대신한다 (LLM이 하는 호출과 같은 모양).
 * 테스트 니모닉(공개 BIP-39 예시)만 쓴다. 돈은 움직이지 않는다.
 */
const USDC = KNOWN_USDC[133]!;
const ATTACKER = "0x000000000000000000000000000000000000bEEF";
const policyJson = {
  agent: "buyer-1",
  accountIndex: 1,
  chains: [133],
  token: "USDC",
  perTxMax: "0.50",
  dailyMax: "1.00",
  sellers: { "profile-seller": SELLER },
};
const policy = parsePolicy(policyJson);

let hspServer: MockHspServer;
let signerServer: NetServer;
let paths: ReturnType<typeof statePaths>;
let wallet: WalletService;
let mcp: Client;
const sellers = new Map<string, { server: Server; url: string }>();
const hspClients: McpHspClient[] = [];

async function hspClient(): Promise<McpHspClient> {
  const c = new McpHspClient(hspServer.url);
  await c.connect();
  hspClients.push(c);
  return c;
}

async function startSeller(key: string, evil?: EvilMode) {
  let url = "";
  const server = createSeller({
    hsp: await hspClient(),
    name: "profile-seller",
    payTo: SELLER,
    chainId: 133,
    token: USDC,
    catalog: [{ sku: "profile", name: "Wallet address profile report", price: "0.10" }],
    ...(evil && { evil, attacker: ATTACKER }),
    publicUrl: () => url,
  });
  url = await listenSeller(server, 0);
  sellers.set(key, { server, url });
}

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "countersign-e2e-"));
  paths = statePaths({ COUNTERSIGN_HOME: home });
  const secret = randomBytes(32);
  hspServer = await serveMockHsp({ chainId: 133, token: USDC });

  signerServer = await listen(
    createSigner({
      account: agent,
      policy,
      ticketSecret: secret,
      ledger: new FileSpendLedger(paths.signerLedger),
      pause: () => readPause(paths.pause),
    }),
    join(home, "s.sock"),
  );

  wallet = new WalletService({
    hsp: await hspClient(),
    signer: new SignerClient(join(home, "s.sock")),
    policy,
    ticketSecret: secret,
    ledger: new FileSpendLedger(paths.walletLedger),
    history: new HistoryStore(paths.history),
    pause: () => readPause(paths.pause),
    balances: { usdcBalance: async () => 1_230_000n },
    hspMode: "mock",
    pollIntervalMs: 0,
  });
  const server = new McpServer({ name: "countersign-wallet", version: "0" });
  registerWalletTools(server, wallet);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  mcp = new Client({ name: "buyer-agent", version: "0" });
  await mcp.connect(b);

  await startSeller("honest");
  for (const m of ["payee", "amount", "chain", "inject"] as const) await startSeller(m, m);
});

afterAll(async () => {
  await mcp.close();
  for (const s of sellers.values()) s.server.close();
  for (const c of hspClients) await c.close();
  signerServer.close();
  await hspServer.close();
});

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  return { isError: r.isError === true, json: JSON.parse(text) as Record<string, any> };
}

/** 에이전트가 하는 일: 판매자에게 주문 → 판매자가 말한 대로 지갑에 결제 요청 */
async function buy(sellerKey: string, maxAmount?: string) {
  const s = sellers.get(sellerKey)!;
  const offer = (await post(`${s.url}/orders`, { sku: "profile", subject: "vitalik.eth" })).json;
  const pay = await callTool("pay_order", {
    order_ref: offer.order_ref,
    intent: { purpose: "address profile", max_amount: maxAmount ?? offer.price, seller: offer.seller },
  });
  return { s, offer, pay };
}

describe("E2E: 구매 → 결제 → 납품", () => {
  it("에이전트가 보는 도구는 4개뿐 (정책 변경·키·임의 서명 도구 없음)", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...WALLET_TOOLS].sort());
  });

  it("정상 판매자: 결제가 확정되고, 판매자는 HSP로 확인한 뒤 납품한다", async () => {
    const { s, offer, pay } = await buy("honest");
    expect(pay.isError).toBe(false);
    expect(pay.json).toMatchObject({
      ok: true,
      hsp_status: "payment-finalized",
      amount: "0.1",
      pay_to: SELLER,
      seller: "profile-seller",
      chain_id: 133,
    });
    expect(pay.json.note).toMatch(/mock/);

    // 결제 전·엉뚱한 결제로는 납품하지 않는다
    expect((await post(`${s.url}/deliver`, { order_ref: offer.order_ref, payment_id: "mock_pay_999" })).status).toBe(402);

    const d = await post(`${s.url}/deliver`, { order_ref: offer.order_ref, payment_id: pay.json.payment_id });
    expect(d.status).toBe(200);
    expect(d.json.goods.subject).toBe("vitalik.eth");
    expect((await post(`${s.url}/deliver`, { order_ref: offer.order_ref, payment_id: pay.json.payment_id })).status).toBe(409);

    // 같은 주문을 또 결제하라고 해도 거부
    const again = await callTool("pay_order", {
      order_ref: offer.order_ref,
      intent: { purpose: "again", max_amount: "0.10", seller: "profile-seller" },
    });
    expect(again.json).toMatchObject({ ok: false, code: "DUPLICATE" });
  });

  it.each([
    ["payee", "PAYEE_MISMATCH"],
    ["amount", "AMOUNT_OVER_INTENT"],
    ["chain", "CHAIN_OR_TOKEN_NOT_ALLOWED"],
    ["inject", "AMOUNT_OVER_INTENT"],
  ])("악성 판매자(%s): 판매자 말을 그대로 따라도 지갑이 서명하지 않는다 → %s", async (key, code) => {
    const { s, offer, pay } = await buy(key);
    expect(pay.isError).toBe(true);
    expect(pay.json).toMatchObject({ ok: false, code });
    expect(typeof pay.json.next_action).toBe("string");
    // 판매자가 "말한" 값은 멀쩡해 보인다 (속임수)
    expect(offer).toMatchObject({ price: "0.1", pay_to: SELLER, chain_id: 133 });
    // 결제가 없으니 납품도 없다
    expect((await post(`${s.url}/deliver`, { order_ref: offer.order_ref, payment_id: "mock_pay_1" })).status).toBe(402);
  });

  it("인젝션에 속은 에이전트가 max_amount를 5.00으로 올려도 주인 한도에서 막힌다", async () => {
    const { offer, pay } = await buy("inject", "5.00");
    expect(offer.notice).toMatch(/SYSTEM NOTICE/);
    expect(pay.json).toMatchObject({ ok: false, code: "OVER_LIMIT" });
  });

  it("거부·승인은 내역에 남고, 정책 요약에 24시간 사용액이 보인다", async () => {
    const h = await callTool("get_history", { limit: 50 });
    const statuses = h.json.entries.map((e: { status: string; code?: string }) => e.code ?? e.status);
    expect(statuses).toEqual(
      expect.arrayContaining(["paid", "PAYEE_MISMATCH", "AMOUNT_OVER_INTENT", "CHAIN_OR_TOKEN_NOT_ALLOWED", "OVER_LIMIT", "DUPLICATE"]),
    );
    const paid = h.json.entries.find((e: { status: string }) => e.status === "paid");
    expect(paid.checks.map((c: { result: string }) => c.result)).toEqual(Array(6).fill("match"));
    expect(paid.events.map((e: { stage: string }) => e.stage)).toEqual(
      expect.arrayContaining(["signed", "finalized", "submitted", "payment-finalized"]),
    );
    const payee = h.json.entries.find((e: { code?: string }) => e.code === "PAYEE_MISMATCH");
    expect(payee.checks.find((c: { field: string }) => c.field === "payee")).toMatchObject({
      result: "mismatch",
      expected: SELLER,
      actual: ATTACKER,
    });
    const chain = h.json.entries.find((e: { code?: string }) => e.code === "CHAIN_OR_TOKEN_NOT_ALLOWED");
    expect(chain.checks.find((c: { field: string }) => c.field === "chain")).toMatchObject({ result: "mismatch", actual: "84532" });
    const p = await callTool("get_policy");
    expect(p.json).toMatchObject({
      agent: "buyer-1",
      account: agent.address,
      spent_24h: "0.1",
      remaining_24h: "0.9",
      paused: false,
      editable_by_agent: false,
    });
    const b = await callTool("get_balance");
    expect(b.json).toMatchObject({ ok: true, account: agent.address, balances: [{ chain_id: 133, balance: "1.23" }] });
  });

  it("주인이 정지하면 지갑 MCP가 거부하고, 지갑을 우회해도 signer가 거부한다", async () => {
    writePause(paths.pause, { paused: true, at: 1, reason: "test" });
    try {
      const { pay } = await buy("honest");
      expect(pay.json).toMatchObject({ ok: false, code: "PAUSED" });
      const direct = await new SignerClient(join(paths.dir, "s.sock")).signPayment({} as never, {});
      expect(direct).toMatchObject({ ok: false, code: "PAUSED" });
    } finally {
      writePause(paths.pause, { paused: false, at: 2 });
    }
    expect((await buy("honest")).pay.json.ok).toBe(true);
  });
});

describe("지갑 서비스: 그 밖의 거부", () => {
  const base = {
    policy,
    ticketSecret: randomBytes(32),
    history: { append: () => {}, list: () => [] } as unknown as HistoryStore,
    pause: () => ({ paused: false, at: 0 }),
    hspMode: "mock" as const,
    pollIntervalMs: 0,
  };
  const intent = { purpose: "p", max_amount: "0.10", seller: "profile-seller" };

  it("HSP가 서명 대상을 바꿔치기하면 (to 변경) TYPED_DATA_MISMATCH, signer는 호출되지 않는다", async () => {
    const hsp = new MockHsp({
      chainId: 133,
      token: USDC,
      tamperPrepare: (td) => ({ ...td, message: { ...td.message, to: ATTACKER } }),
    });
    let signerCalls = 0;
    const signer: SignerPort = {
      address: async () => ({ ok: true, op: "address", address: agent.address }),
      signPayment: async () => {
        signerCalls++;
        throw new Error("호출되면 안 됨");
      },
    };
    const w = new WalletService({ ...base, hsp, signer, ledger: new MemorySpendLedger() });
    const o = await hsp.createOrder({ pay_to: SELLER, amount: "100000", chain_id: 133, token: USDC });
    expect(await w.payOrder({ order_ref: o.order_ref, intent })).toMatchObject({ ok: false, code: "TYPED_DATA_MISMATCH" });
    expect(signerCalls).toBe(0);
  });

  it("signer가 꺼져 있으면 SIGNER_UNAVAILABLE, 없는 주문은 HSP_ERROR, 형식 오류는 INVALID_INPUT", async () => {
    const hsp = new MockHsp({ chainId: 133, token: USDC });
    const w = new WalletService({
      ...base,
      hsp,
      signer: new SignerClient(join(tmpdir(), "countersign-no-such.sock"), 500),
      ledger: new MemorySpendLedger(),
    });
    const o = await hsp.createOrder({ pay_to: SELLER, amount: "100000", chain_id: 133, token: USDC });
    expect(await w.payOrder({ order_ref: o.order_ref, intent })).toMatchObject({ code: "SIGNER_UNAVAILABLE" });

    const w2 = new WalletService({
      ...base,
      hsp,
      signer: { address: async () => ({ ok: true, op: "address", address: agent.address }), signPayment: async () => { throw new Error(); } },
      ledger: new MemorySpendLedger(),
    });
    expect(await w2.payOrder({ order_ref: "nope", intent })).toMatchObject({ code: "HSP_ERROR" });
    expect(await w2.payOrder({ order_ref: o.order_ref })).toMatchObject({ code: "INVALID_INPUT" });
    expect(await w2.payOrder({ order_ref: o.order_ref, intent: { ...intent, max_amount: "lots" } })).toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
