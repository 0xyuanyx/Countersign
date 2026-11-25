import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_USDC, McpHspClient, serveMockHsp, type MockHspServer } from "@countersign/hsp";
import { createSeller, listenSeller } from "@countersign/seller";
import { SignerClient, createSigner, listen } from "@countersign/signer";
import {
  ApprovalStore,
  ConnectionStore,
  FileSpendLedger,
  HistoryStore,
  PolicyFile,
  TaskStore,
  readPause,
  statePaths,
} from "@countersign/wallet-core";
import { SELLER, agent, policyJson } from "@countersign/wallet-core/testkit";
import { WalletService, createWalletHttp, listenWalletHttp } from "@countersign/wallet-mcp";
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
  signerSrv = await listen(
    createSigner({
      account: agent,
      policy: () => policyFile.get(),
      ticketSecret: secret,
      ledger: new FileSpendLedger(paths.signerLedger),
      pause: () => readPause(paths.pause),
      extras: (orderRef, intent) => ({
        approval: approvals.approvalFor(orderRef),
        task: tasks.extraFor((intent as { task_id?: string })?.task_id),
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
  const wallet = new WalletService({
    hsp: await hspClient(),
    signer: new SignerClient(join(home, "s.sock")),
    policy: () => policyFile.get(),
    ticketSecret: secret,
    ledger: new FileSpendLedger(paths.walletLedger),
    history: new HistoryStore(paths.history),
    pause: () => readPause(paths.pause),
    approvals,
    tasks,
    hspMode: "mock",
    pollIntervalMs: 0,
  });
  walletSrv = createWalletHttp(wallet, new ConnectionStore(paths.connections));
  walletUrl = await listenWalletHttp(walletSrv, 0);
  ownerSrv = createOwnerApi({ policy: policyFile, paths, ownerToken: OWNER, publicMcpUrl: walletUrl });
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
      catalog: [{ sku: "item", name: `${name} item`, price: "0.10" }],
      publicUrl: () => url,
    });
    url = await listenSeller(srv, 0);
    sellers[key] = url;
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
    const { call, client } = await connectAgent("codex");
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
    expect(policyFile.json().sellers["news-seller"]).toBe(NEW_SELLER);

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
