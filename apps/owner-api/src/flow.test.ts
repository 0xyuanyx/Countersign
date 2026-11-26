import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_USDC, McpHspClient, serveMockHsp, type MockHspServer } from "@countersign/hsp";
import { createSeller, listenSeller } from "@countersign/seller";
import { SignerClient, createSigner, listen, registryAgents } from "@countersign/signer";
import {
  AgentRegistry,
  ApprovalStore,
  FileSpendLedger,
  HistoryStore,
  PolicyFile,
  SeenStore,
  TaskStore,
  deriveAccount,
  readPause,
  statePaths,
} from "@countersign/wallet-core";
import { SELLER, TEST_WORDS, agent, policyJson } from "@countersign/wallet-core/testkit";
import { createWalletHttp, listenWalletHttp, walletFactory } from "@countersign/wallet-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOwnerApi, listenOwnerApi } from "./server.js";

/**
 * 폰 앱 흐름 끝에서 끝: 주인 API로 에이전트 연결을 만들고 → 에이전트가 원격 MCP(HTTP)로 붙어 →
 * 처음 보는 판매자 결제는 주인 승인 대기 → 앱에서 승인("다음부터 묻지 않기") → 재시도하면 결제.
 * 맡기기(할 일 + 최대 금액)와 연결 끊기도 확인한다. 테스트 니모닉만 쓰고 돈은 움직이지 않는다.
 */
const USDC = KNOWN_USDC[133]!;
const NEW_SELLER = "0x00000000000000000000000000000000000000C3"; // 체크섬 형태
const OWNER = "f".repeat(64);
const home = mkdtempSync(join(tmpdir(), "countersign-flow-"));
const paths = statePaths({ COUNTERSIGN_HOME: home });
const policyPath = join(home, "policy.json");
writeFileSync(policyPath, JSON.stringify({ ...policyJson, dailyMax: "5.00" }));
const policyFile = new PolicyFile(policyPath);

const OWNER0 = deriveAccount(TEST_WORDS, 0).address;
const catalogSellers: { url: string; scenario: "normal" | "new_seller" }[] = [];
const withdrawCalls: { id: string; amount: bigint | undefined }[] = [];
let hsp: MockHspServer;
let signerSrv: NetServer;
let walletSrv: Server;
let ownerSrv: Server;
let walletUrl: string;
let ownerUrl: string;
const sellers: Record<string, string> = {};
const closers: (() => unknown)[] = [];

beforeAll(async () => {
  const secret = randomBytes(32);
  hsp = await serveMockHsp({ chainId: 133, token: USDC });
  const approvals = new ApprovalStore(paths.approvals);
  const tasks = new TaskStore(paths.tasks);
  const registry = new AgentRegistry(paths, policyPath);
  const derive = (i: number) => deriveAccount(TEST_WORDS, i);
  signerSrv = await listen(
    createSigner({
      account: agent,
      policy: () => policyFile.get(),
      agents: registryAgents(registry, derive),
      ticketSecret: secret,
      ledger: new FileSpendLedger(paths.signerLedger),
      pause: () => readPause(paths.pause),
      extras: (orderRef, intent, agentId) => ({
        approval: approvals.approvalFor(orderRef, agentId),
        task: tasks.extraFor((intent as { task_id?: string })?.task_id, agentId),
      }),
    }),
    join(home, "s.sock"),
  );
  const hspClient = async () => {
    const c = new McpHspClient(hsp.url);
    await c.connect();
    closers.push(() => c.close());
    return c;
  };
  const signerClient = new SignerClient(join(home, "s.sock"));
  const walletFor = walletFactory(registry, signerClient, {
    hsp: await hspClient(),
    ticketSecret: secret,
    history: new HistoryStore(paths.history),
    pause: () => readPause(paths.pause),
    approvals,
    tasks,
    hspMode: "mock",
    pollIntervalMs: 0,
  });
  walletSrv = createWalletHttp(walletFor, registry.connections, new SeenStore(paths.seen));
  walletUrl = await listenWalletHttp(walletSrv, 0);
  ownerSrv = createOwnerApi({
    policy: policyFile,
    paths,
    ownerToken: OWNER,
    publicMcpUrl: walletUrl,
    catalogSellers,
    agentOps: {
      address: async (id) => {
        const r = await signerClient.forAgent(id).address();
        return r.ok && r.op === "address" ? r.address : undefined;
      },
      // 실제 RPC 대신 고정값 (에이전트 주소별로 다르게)
      usdcBalance: async (_c, _t, owner) => (owner.toLowerCase() === agent.address.toLowerCase() ? 40_000_000n : 0n),
      nativeBalance: async () => 0n,
      withdraw: async (id, amount) => {
        withdrawCalls.push({ id, amount });
        return { ok: true, tx_hash: `0x${"ab".repeat(32)}`, from: agent.address, to: OWNER0, amount: String(amount ?? 40_000_000n), chain_id: 133, token: USDC };
      },
    },
  });
  ownerUrl = await listenOwnerApi(ownerSrv, 0);

  for (const [key, name, payTo] of [
    ["profile", "profile-seller", SELLER],
    ["news", "news-seller", NEW_SELLER],
  ] as const) {
    let url = "";
    const srv = createSeller({
      hsp: await hspClient(),
      name,
      payTo,
      chainId: 133,
      token: USDC,
      catalog: [
        { sku: "item", name: `${name} item`, price: "0.10", example: `${name} 상품 사 와` },
        { sku: "big", name: `${name} big item`, price: "0.60", example: `${name} 큰 상품 사 와` },
      ],
      publicUrl: () => url,
    });
    url = await listenSeller(srv, 0);
    sellers[key] = url;
    catalogSellers.push({ url, scenario: key === "profile" ? "normal" : "new_seller" });
    closers.push(() => srv.close());
  }
});

afterAll(async () => {
  for (const c of closers) await c();
  walletSrv.close();
  ownerSrv.close();
  signerSrv.close();
  await hsp.close();
});

const owner = async (method: string, path: string, body?: unknown, auth = true) => {
  const r = await fetch(`${ownerUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth && { Authorization: `Bearer ${OWNER}` }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json()) as any };
};
const post = async (url: string, body: unknown) =>
  (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as any;

async function connectAgent(name: string) {
  const created = await owner("POST", "/api/agents", { name });
  expect(created.status).toBe(201);
  const client = new Client({ name, version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(created.json.connect.url)));
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    return JSON.parse((r.content as { text: string }[])[0]!.text) as any;
  };
  return { created: created.json, client, call };
}

async function buyFrom(call: (t: string, a?: Record<string, unknown>) => Promise<any>, key: string, extra: Record<string, unknown> = {}) {
  const offer = await post(`${sellers[key]}/orders`, { sku: "item" });
  const intent = { purpose: offer.item, max_amount: offer.price, seller: offer.seller, ...extra };
  return { offer, intent, pay: await call("pay_order", { order_ref: offer.order_ref, intent }) };
}

describe("폰 앱 + 원격 MCP 흐름", () => {
  it("주인이 만든 연결 주소로 원격 MCP에 붙고, 토큰이 없으면 401", async () => {
    const { created, client, call } = await connectAgent("claude-desktop");
    expect(created.token).toMatch(/^cs_/);
    expect(created.connect.claude_code).toContain("--transport http");
    expect(created.connect.cursor).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["pay_order", "next_task", "finish_task"]));
    expect((await call("get_policy")).agent).toBe("buyer-1");
    expect((await fetch(`${walletUrl}/mcp/cs_${"x".repeat(32)}`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${walletUrl}/mcp`, { method: "POST" })).status).toBe(401);
    // 연결 만들기는 주인 토큰 필요
    expect((await owner("POST", "/api/agents", { name: "sneaky" }, false)).status).toBe(401);
    await client.close();
  });

  it("처음 보는 판매자 → 주인 승인 대기 → 앱에서 승인(다음부터 묻지 않기) → 재시도하면 결제, 다음 주문은 바로 결제", async () => {
    const { call, client, created: codex } = await connectAgent("codex");
    const first = await buyFrom(call, "news");
    expect(first.pay).toMatchObject({ ok: false, code: "NEEDS_OWNER_APPROVAL" });
    const reqId = first.pay.request_id;

    const pending = await owner("GET", "/api/requests?status=pending", undefined, false);
    expect(pending.json.requests).toEqual([
      expect.objectContaining({ id: reqId, seller: "news-seller", pay_to: NEW_SELLER, amount: "0.1", agent: "codex" }),
    ]);
    const hist = (await owner("GET", "/api/history?limit=1", undefined, false)).json.entries[0];
    expect(hist).toMatchObject({ status: "pending", request_id: reqId, agent: "codex" });
    expect(hist.checks.find((c: any) => c.field === "payee").result).toBe("needs_approval");

    // 같은 주문을 다시 불러도 요청은 하나
    expect((await call("pay_order", { order_ref: first.offer.order_ref, intent: first.intent })).request_id).toBe(reqId);

    expect((await owner("POST", `/api/requests/${reqId}/approve`, { remember: true }, false)).status).toBe(401);
    expect((await owner("POST", `/api/requests/${reqId}/approve`, { remember: true })).json).toMatchObject({ status: "approved", remember: true });
    // "다음부터 묻지 않기"는 요청한 에이전트의 정책에만 들어간다
    expect((await owner("GET", `/api/agents/${codex.id}/policy/file`, undefined, false)).json.sellers["news-seller"]).toBe(NEW_SELLER);
    expect(policyFile.json().sellers["news-seller"]).toBeUndefined();

    expect(await call("pay_order", { order_ref: first.offer.order_ref, intent: first.intent })).toMatchObject({
      ok: true,
      pay_to: NEW_SELLER,
      hsp_status: "payment-finalized",
    });
    expect((await buyFrom(call, "news")).pay).toMatchObject({ ok: true });
    await client.close();
  });

  it("주인이 거절하면 OWNER_REJECTED, 승인만 하고 기억하지 않으면 다음 주문은 다시 묻는다", async () => {
    policyFile.update({ sellers: { "profile-seller": SELLER } }); // news-seller 등록 해제
    const { call, client } = await connectAgent("cursor");
    const a = await buyFrom(call, "news");
    await owner("POST", `/api/requests/${a.pay.request_id}/reject`, {});
    expect(await call("pay_order", { order_ref: a.offer.order_ref, intent: a.intent })).toMatchObject({ code: "OWNER_REJECTED" });

    const b = await buyFrom(call, "news");
    await owner("POST", `/api/requests/${b.pay.request_id}/approve`, {});
    expect((await call("pay_order", { order_ref: b.offer.order_ref, intent: b.intent })).ok).toBe(true);
    expect((await buyFrom(call, "news")).pay).toMatchObject({ code: "NEEDS_OWNER_APPROVAL" });
    await client.close();
  });

  it("등록 판매자 이름으로 다른 주소면 승인 요청 없이 PAYEE_MISMATCH", async () => {
    const { call, client } = await connectAgent("liar");
    const { pay } = await buyFrom(call, "news", { seller: "profile-seller" });
    expect(pay).toMatchObject({ code: "PAYEE_MISMATCH" });
    expect(pay.request_id).toBeUndefined();
    await client.close();
  });

  it("맡기기: 에이전트가 일을 받아 가고, 지갑이 일의 최대 금액을 강제한다", async () => {
    const small = await owner("POST", "/api/tasks", { text: "주소 프로필 하나 사 와", maxAmount: "0.05" });
    expect(small.status).toBe(201);
    const { call, client } = await connectAgent("runner");
    const got = await call("next_task");
    expect(got.task).toMatchObject({ id: small.json.id, max_amount: "0.05" });
    // 에이전트가 intent.max_amount를 0.10으로 적어도 일의 상한 0.05에서 막힌다
    expect((await buyFrom(call, "profile", { task_id: got.task.id })).pay).toMatchObject({ code: "AMOUNT_OVER_INTENT" });
    expect(await call("finish_task", { task_id: got.task.id, status: "failed", note: "가격이 0.10이라 못 삼" })).toMatchObject({ ok: true });

    const big = await owner("POST", "/api/tasks", { text: "주소 프로필 하나 사 와", maxAmount: "0.20" });
    const got2 = await call("next_task");
    expect(got2.task.id).toBe(big.json.id);
    expect((await buyFrom(call, "profile", { task_id: got2.task.id })).pay).toMatchObject({ ok: true });
    const tasks = (await owner("GET", "/api/tasks", undefined, false)).json.tasks;
    expect(tasks.find((t: any) => t.id === big.json.id)).toMatchObject({ status: "paid", agent: "runner" });
    expect(tasks.find((t: any) => t.id === small.json.id)).toMatchObject({ status: "failed", note: "가격이 0.10이라 못 삼" });

    // 그만둔 일로는 결제 못 함
    const c = await owner("POST", "/api/tasks", { text: "x", maxAmount: "0.20" });
    await owner("POST", `/api/tasks/${c.json.id}/cancel`, {});
    expect((await buyFrom(call, "profile", { task_id: c.json.id })).pay).toMatchObject({ code: "INVALID_INPUT" });
    await client.close();
  });

  it("every_payment 모드로 바꾸면 등록 판매자도 주인 승인 대기 (signer도 같은 규칙)", async () => {
    expect((await owner("PATCH", "/api/policy", { approvalMode: "every_payment" })).json.approval_mode).toBe("every_payment");
    const { call, client } = await connectAgent("strict");
    const a = await buyFrom(call, "profile");
    expect(a.pay).toMatchObject({ code: "NEEDS_OWNER_APPROVAL" });
    await owner("POST", `/api/requests/${a.pay.request_id}/approve`, {});
    expect((await call("pay_order", { order_ref: a.offer.order_ref, intent: a.intent })).ok).toBe(true);
    await owner("PATCH", "/api/policy", { approvalMode: "unknown_seller" });
    await client.close();
  });

  it("에이전트 하나만 멈추면 그 연결의 결제만 WALLET_PAUSED, 이름을 바꿔도 활동 기록이 이어진다", async () => {
    const a = await connectAgent("pausable");
    const b = await connectAgent("other");
    expect((await buyFrom(a.call, "profile")).pay.ok).toBe(true);

    expect((await owner("POST", `/api/agents/${a.created.id}/pause`, {}, false)).status).toBe(401);
    expect((await owner("POST", `/api/agents/${a.created.id}/pause`, {})).json).toMatchObject({ paused: true });
    // 이미 열려 있던 연결도 다음 결제부터 바로 막힌다
    expect((await buyFrom(a.call, "profile")).pay).toMatchObject({ ok: false, code: "WALLET_PAUSED" });
    expect((await buyFrom(b.call, "profile")).pay.ok).toBe(true);
    const listed = (await owner("GET", "/api/agents", undefined, false)).json.agents;
    expect(listed.find((x: any) => x.id === a.created.id)).toMatchObject({ paused: true });
    expect(listed.find((x: any) => x.id === b.created.id)).toMatchObject({ paused: false });

    expect((await owner("PATCH", `/api/agents/${a.created.id}`, { name: "other" })).status).toBe(409);
    expect((await owner("PATCH", `/api/agents/${a.created.id}`, { name: "renamed" }, false)).status).toBe(401);
    expect((await owner("PATCH", `/api/agents/${a.created.id}`, { name: "renamed" })).json).toMatchObject({ name: "renamed", paused: true });
    await owner("POST", `/api/agents/${a.created.id}/resume`, {});
    expect((await buyFrom(a.call, "profile")).pay.ok).toBe(true);
    const after = (await owner("GET", "/api/agents", undefined, false)).json.agents.find((x: any) => x.id === a.created.id);
    expect(after).toMatchObject({ name: "renamed", paused: false, last_activity_at: expect.any(Number) });
    await a.client.close();
    await b.client.close();
  });

  it("에이전트마다 계정·정책·지출 기록이 따로: 주소가 다르고, 한 에이전트의 판매자 등록·한도가 다른 에이전트에 번지지 않는다", async () => {
    const x = await connectAgent("multi-x");
    const y = await connectAgent("multi-y");
    expect(x.created.account_index).not.toBe(y.created.account_index);
    expect(x.created.address).toBeTruthy();
    expect(x.created.address).not.toBe(y.created.address);
    expect(x.created.deposit).toMatchObject({ address: x.created.address, chain_id: 133, token_symbol: "USDC" });
    // signer가 그 계정 번호로 파생한 주소와 같다
    expect(x.created.address).toBe(deriveAccount(TEST_WORDS, x.created.account_index).address);

    // 실제로 붙었는지: initialize 성공 시각
    const listed = (await owner("GET", "/api/agents", undefined, false)).json.agents;
    expect(listed.find((a: any) => a.id === x.created.id)).toMatchObject({ connected: true, attached_at: expect.any(Number) });

    // x의 한도를 0.05로 내리면 x만 막힌다
    expect((await owner("PATCH", `/api/agents/${x.created.id}/policy`, { perTxMax: "0.05" })).json).toMatchObject({ per_tx_max: "0.05", agent_id: x.created.id });
    expect((await buyFrom(x.call, "profile")).pay).toMatchObject({ code: "OVER_LIMIT" });
    const paid = await buyFrom(y.call, "profile");
    expect(paid.pay).toMatchObject({ ok: true });

    // 내역은 에이전트별로 나뉘고, 결제 항목에는 tx_hash·chain_id와 mock 표시가 있다
    const yh = (await owner("GET", `/api/agents/${y.created.id}/history`, undefined, false)).json.entries;
    expect(yh.every((e: any) => e.agent_id === y.created.id)).toBe(true);
    expect(yh[0]).toMatchObject({ status: "paid", kind: "payment", chain_id: 133, simulated: true, from: y.created.address, tx_hash: expect.stringMatching(/^0x/) });
    const xh = (await owner("GET", `/api/history?agent=${x.created.id}`, undefined, false)).json.entries;
    expect(xh[0]).toMatchObject({ code: "OVER_LIMIT", agent_id: x.created.id });

    // 상세 화면 한 번에: 에이전트·정책·잔액·입금
    const detail = (await owner("GET", `/api/agents/${y.created.id}`, undefined, false)).json;
    expect(detail).toMatchObject({
      agent: { id: y.created.id, address: y.created.address },
      policy: { spent_24h: "0.1", agent_id: y.created.id },
      balance: { usdc: "0", native: "0", chain_id: 133 },
      deposit: { address: y.created.address },
    });
    expect((await owner("GET", `/api/agents/${x.created.id}/policy`, undefined, false)).json.spent_24h).toBe("0");
    await x.client.close();
    await y.client.close();
  });

  it("출금: 주인 토큰 필요, 받는 곳은 주인 0번 계정 고정, 내역에 kind:withdraw로 남는다", async () => {
    const z = await connectAgent("wd");
    expect((await owner("POST", `/api/agents/${z.created.id}/withdraw`, {}, false)).status).toBe(401);
    expect((await owner("POST", `/api/agents/${z.created.id}/withdraw`, { amount: "0" })).status).toBe(400);
    expect((await owner("POST", `/api/agents/${z.created.id}/withdraw`, { to: "0xbad" })).status).toBe(400); // 받는 곳은 못 고른다
    const r = await owner("POST", `/api/agents/${z.created.id}/withdraw`, { amount: "1.5" });
    expect(r.json).toMatchObject({ ok: true, to: OWNER0, amount: "1.5", explorer_url: expect.stringContaining("/tx/0x") });
    expect(withdrawCalls.at(-1)).toEqual({ id: z.created.id, amount: 1_500_000n });
    const h = (await owner("GET", `/api/agents/${z.created.id}/history`, undefined, false)).json.entries[0];
    expect(h).toMatchObject({ kind: "withdraw", status: "paid", pay_to: OWNER0, tx_hash: `0x${"ab".repeat(32)}` });
    await z.client.close();
  });

  it("맡긴 일을 특정 에이전트에게: 그 에이전트만 받아 간다", async () => {
    const a1 = await connectAgent("task-a");
    const b1 = await connectAgent("task-b");
    const t = await owner("POST", "/api/tasks", { text: "only a", maxAmount: "0.20", agentId: a1.created.id });
    expect(t.json.agent_id).toBe(a1.created.id);
    expect((await b1.call("next_task")).task).toBeNull();
    expect((await a1.call("next_task")).task.id).toBe(t.json.id);
    expect((await owner("GET", `/api/tasks?agentId=${a1.created.id}`, undefined, false)).json.tasks.map((x: any) => x.id)).toEqual([t.json.id]);
    await a1.client.close();
    await b1.client.close();
  });

  it("숨기기: 끊긴 연결이고 USDC 0일 때만, 숨겨도 목록·정책·내역은 남는다", async () => {
    const h = await connectAgent("hide-me");
    await buyFrom(h.call, "profile"); // 내역 하나 남기기
    expect((await owner("PATCH", `/api/agents/${h.created.id}`, { hidden: true }, false)).status).toBe(401);
    const live = await owner("PATCH", `/api/agents/${h.created.id}`, { hidden: true });
    expect(live.status).toBe(400);
    expect(live.json.error).toMatch(/끊어야/);
    await owner("POST", `/api/agents/${h.created.id}/disconnect`, {});
    expect((await owner("PATCH", `/api/agents/${h.created.id}`, { hidden: true })).json).toMatchObject({ hidden: true, active: false });
    const listed = (await owner("GET", "/api/agents", undefined, false)).json.agents.find((x: any) => x.id === h.created.id);
    expect(listed).toMatchObject({ hidden: true });
    expect((await owner("GET", `/api/agents/${h.created.id}/history`, undefined, false)).json.entries.length).toBeGreaterThan(0);
    expect((await owner("GET", `/api/agents/${h.created.id}/policy/file`, undefined, false)).status).toBe(200);
    expect((await owner("PATCH", `/api/agents/${h.created.id}`, { hidden: false })).json.hidden).toBe(false);

    // 잔액이 남은 계정(1번, 테스트에선 40 USDC)은 끊어도 못 숨긴다
    const first = (await owner("GET", "/api/agents", undefined, false)).json.agents.find((x: any) => x.account_index === 1);
    await owner("POST", `/api/agents/${first.id}/disconnect`, {});
    const r = await owner("PATCH", `/api/agents/${first.id}`, { hidden: true });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/잔액이 40/);
    await h.client.close();
  });

  it("상품 목록(추천 칩): 판매자별 상품·가격·예시 문장, 에이전트 한도를 넘는 상품은 over_limit 표시", async () => {
    const cat = (await owner("GET", "/api/catalog", undefined, false)).json;
    expect(cat.sellers.map((x: any) => x.scenario)).toEqual(["normal", "new_seller"]);
    const chip = cat.chips.find((c: any) => c.seller === "profile-seller" && c.sku === "item");
    expect(chip).toMatchObject({ label: "profile-seller 상품 사 와", price: "0.10", scenario: "normal", seller_url: sellers.profile });
    expect(chip.task_text).toContain(sellers.profile);
    const first = (await owner("GET", "/api/agents", undefined, false)).json.agents.find((x: any) => x.account_index === 1);
    const scoped = (await owner("GET", `/api/catalog?agent=${first.id}`, undefined, false)).json.chips;
    expect(scoped.find((c: any) => c.sku === "big" && c.seller === "profile-seller")).toMatchObject({ scenario: "over_limit", exceeds_per_tx: true });
  });

  it("맡긴 일 하나씩 멈춤·재개·취소: 멈춘 일은 next_task로 안 주고 결제·승인도 막힌다, 취소하면 대기 요청도 거절", async () => {
    const ag = await connectAgent("task-ctl");
    const t = await owner("POST", "/api/tasks", { text: "news 사 와", maxAmount: "0.20", agentId: ag.created.id });
    expect((await owner("POST", `/api/tasks/${t.json.id}/pause`, {}, false)).status).toBe(401);
    expect((await owner("POST", `/api/tasks/${t.json.id}/pause`, {})).json).toMatchObject({ status: "paused", paused_from: "open" });
    expect((await ag.call("next_task")).task).toBeNull();
    expect((await owner("POST", `/api/tasks/${t.json.id}/resume`, {})).json.status).toBe("open");
    expect((await ag.call("next_task")).task.id).toBe(t.json.id);

    // 진행 중에 처음 보는 판매자 → 승인 대기. 그 사이 일을 멈추면 승인도 결제도 안 된다
    const a = await buyFrom(ag.call, "news", { task_id: t.json.id });
    expect(a.pay).toMatchObject({ code: "NEEDS_OWNER_APPROVAL" });
    await owner("POST", `/api/tasks/${t.json.id}/pause`, {});
    expect((await owner("POST", `/api/requests/${a.pay.request_id}/approve`, {})).status).toBe(409);
    expect(await ag.call("pay_order", { order_ref: a.offer.order_ref, intent: a.intent })).toMatchObject({ code: "TASK_PAUSED" });
    expect((await owner("GET", `/api/tasks?agentId=${ag.created.id}`, undefined, false)).json.tasks[0].status).toBe("paused");

    // 청구서가 이미 있는 일은 다시 켜면 working
    expect((await owner("POST", `/api/tasks/${t.json.id}/resume`, {})).json.status).toBe("working");
    // 취소하면 대기 요청도 거절된다
    expect((await owner("POST", `/api/tasks/${t.json.id}/cancel`, {})).json.status).toBe("cancelled");
    const req = (await owner("GET", `/api/requests?agentId=${ag.created.id}`, undefined, false)).json.requests.find((r: any) => r.id === a.pay.request_id);
    expect(req.status).toBe("rejected");
    expect((await owner("POST", `/api/tasks/${t.json.id}/resume`, {})).status).toBe(409);
    expect(await ag.call("pay_order", { order_ref: a.offer.order_ref, intent: a.intent })).toMatchObject({ code: "INVALID_INPUT" });
    await ag.client.close();
  });

  it("주인 승인은 요청한 에이전트에만: 같은 주문을 다른 에이전트가 내밀어도 승인이 옮겨 가지 않는다", async () => {
    const a1 = await connectAgent("appr-a");
    const b1 = await connectAgent("appr-b");
    const offer = await post(`${sellers.news}/orders`, { sku: "item" });
    const intent = { purpose: "x", max_amount: offer.price, seller: offer.seller };
    const pa = await a1.call("pay_order", { order_ref: offer.order_ref, intent });
    expect(pa).toMatchObject({ code: "NEEDS_OWNER_APPROVAL" });
    await owner("POST", `/api/requests/${pa.request_id}/approve`, {});
    const pb = await b1.call("pay_order", { order_ref: offer.order_ref, intent });
    expect(pb).toMatchObject({ code: "NEEDS_OWNER_APPROVAL" });
    expect(pb.request_id).not.toBe(pa.request_id);
    expect((await a1.call("pay_order", { order_ref: offer.order_ref, intent })).ok).toBe(true);
    await a1.client.close();
    await b1.client.close();
  });

  it("MCP get_history는 그 에이전트 것만 (다른 에이전트의 결제·출금 내역은 안 보인다)", async () => {
    const a1 = await connectAgent("hist-a");
    const b1 = await connectAgent("hist-b");
    await buyFrom(a1.call, "profile");
    await buyFrom(b1.call, "profile");
    const ha = (await a1.call("get_history", { limit: 50 })).entries;
    expect(ha.length).toBeGreaterThan(0);
    expect(ha.every((e: any) => e.agent_id === a1.created.id)).toBe(true);
    const hb = (await b1.call("get_history", { limit: 50 })).entries;
    expect(hb.every((e: any) => e.agent_id === b1.created.id)).toBe(true);
    await a1.client.close();
    await b1.client.close();
  });

  it("연결을 끊으면 그 주소는 바로 401, 연결 목록에 마지막 활동이 보인다", async () => {
    const { created, call } = await connectAgent("temp");
    await call("get_policy");
    const list = (await owner("GET", "/api/agents", undefined, false)).json.agents;
    expect(list.find((a: any) => a.name === "codex")).toMatchObject({ connected: true, last_activity_at: expect.any(Number) });
    expect(list.every((a: any) => a.token_sha256 === undefined && a.token === undefined)).toBe(true);
    await owner("POST", `/api/agents/${created.id}/disconnect`, {});
    const r = await fetch(created.connect.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
  });
});
