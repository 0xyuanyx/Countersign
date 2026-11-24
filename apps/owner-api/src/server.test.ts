import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { FileSpendLedger, HistoryStore, PolicyFile, readPause, statePaths } from "@countersign/wallet-core";
import { NOW, policyJson } from "@countersign/wallet-core/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOwnerApi, listenOwnerApi } from "./server.js";

const TOKEN = "a".repeat(64);
const paths = statePaths({ COUNTERSIGN_HOME: mkdtempSync(join(tmpdir(), "countersign-owner-")) });
const policyPath = join(paths.dir, "policy.json");
writeFileSync(policyPath, JSON.stringify(policyJson));
const policy = new PolicyFile(policyPath);
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
    balances: async () => ({ account: "0x0000000000000000000000000000000000000001", balances: [{ chain_id: 133, balance: "1.5" }] }),
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

  it("잔액", async () => {
    expect(await (await req("/api/balance")).json()).toMatchObject({ balances: [{ chain_id: 133, balance: "1.5" }] });
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

  it("정책 변경은 주인 토큰이 있어야 하고, 검증을 통과한 값만 파일에 쓴다", async () => {
    const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    const patch = (body: unknown, headers: Record<string, string> = auth) =>
      req("/api/policy", { method: "PATCH", headers, body: JSON.stringify(body) });

    expect((await patch({ perTxMax: "0.80" }, {})).status).toBe(401);
    const ok = await patch({ perTxMax: "0.80", sellers: { "profile-seller": policyJson.sellers["profile-seller"], "news-seller": "0x00000000000000000000000000000000000000a2" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ per_tx_max: "0.8", sellers: [{ name: "profile-seller" }, { name: "news-seller" }] });
    expect(policy.get().perTxMax).toBe(800_000n);

    // 건당 > 하루, 서명 계정 변경, 모르는 필드, 잘못된 주소 → 400, 파일은 그대로
    for (const bad of [{ perTxMax: "2.00" }, { accountIndex: 2 }, { agent: "x" }, { admin: true }, { sellers: { s: "0x12" } }]) {
      const r = await patch(bad);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/정책을 바꾸지 않음/);
    }
    expect(policy.json()).toMatchObject({ perTxMax: "0.80", accountIndex: 1, agent: "buyer-1" });
    expect((await (await req("/api/policy/file")).json()) as object).toMatchObject({ perTxMax: "0.80" });
  });

  it("정책 추가·삭제 같은 다른 쓰기 경로는 없다", async () => {
    for (const p of ["/api/policy", "/api/limits", "/api/sellers"]) {
      expect((await req(p, { method: "POST", body: "{}" })).status).toBe(404);
    }
  });
});
