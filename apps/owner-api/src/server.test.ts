import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSpendLedger, HistoryStore, readPause, statePaths } from "@countersign/wallet-core";
import { NOW, policy } from "@countersign/wallet-core/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOwnerApi, listenOwnerApi } from "./server.js";

const TOKEN = "a".repeat(64);
const paths = statePaths({ COUNTERSIGN_HOME: mkdtempSync(join(tmpdir(), "countersign-owner-")) });
let server: Server;
let base: string;

beforeAll(async () => {
  new FileSpendLedger(paths.signerLedger).record("o1", 300_000n, NOW - 10);
  new HistoryStore(paths.history).append({ id: "1", at: NOW - 10, order_ref: "o1", status: "paid", amount: "0.3" });
  new HistoryStore(paths.history).append({ id: "2", at: NOW - 5, order_ref: "o2", status: "rejected", code: "PAYEE_MISMATCH" });
  server = createOwnerApi({
    policy,
    paths,
    ownerToken: TOKEN,
    account: async () => "0x0000000000000000000000000000000000000001",
    allowedOrigins: ["http://localhost:5173"],
    now: () => NOW,
  });
  base = await listenOwnerApi(server, 0);
});
afterAll(() => void server.close());

const req = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);

describe("주인 API", () => {
  it("정책 요약에 24시간 사용액과 남은 한도가 보인다", async () => {
    const r = await req("/api/policy");
    expect(await r.json()).toMatchObject({
      agent: "buyer-1",
      account: "0x0000000000000000000000000000000000000001",
      per_tx_max: "0.5",
      daily_max: "1",
      spent_24h: "0.3",
      remaining_24h: "0.7",
      paused: false,
    });
  });

  it("내역은 최신순", async () => {
    const r = (await (await req("/api/history?limit=10")).json()) as { entries: { id: string }[] };
    expect(r.entries.map((e) => e.id)).toEqual(["2", "1"]);
  });

  it("정지는 토큰 없이, 재개는 주인 토큰이 있어야 한다", async () => {
    expect((await req("/api/pause", { method: "POST", body: JSON.stringify({ reason: "이상 거래" }) })).status).toBe(200);
    expect(readPause(paths.pause)).toMatchObject({ paused: true, reason: "이상 거래" });
    expect((await req("/api/resume", { method: "POST" })).status).toBe(401);
    expect((await req("/api/resume", { method: "POST", headers: { Authorization: `Bearer ${"b".repeat(64)}` } })).status).toBe(401);
    expect(readPause(paths.pause).paused).toBe(true);
    expect((await req("/api/resume", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect(readPause(paths.pause).paused).toBe(false);
  });

  it("CORS는 허용한 앱 주소에만 열린다", async () => {
    const ok = await req("/api/policy", { headers: { Origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await req("/api/policy", { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("정책을 바꾸는 경로는 없다", async () => {
    for (const p of ["/api/policy", "/api/limits", "/api/sellers"]) {
      expect((await req(p, { method: "POST", body: "{}" })).status).toBe(404);
    }
  });
});
