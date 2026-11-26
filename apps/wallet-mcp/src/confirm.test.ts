import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_USDC, MockHsp } from "@countersign/hsp";
import { createSigner } from "@countersign/signer";
import { HistoryStore, MemorySpendLedger, TaskStore } from "@countersign/wallet-core";
import { SELLER, agent, policy } from "@countersign/wallet-core/testkit";
import { describe, expect, it } from "vitest";
import { WalletService, type SignerPort } from "./service.js";

/** 결제 확정 / 확인 중 / 실패 구분 (11/27 리뷰 P1-4) */
const USDC = KNOWN_USDC[133]!;
const intent = { purpose: "p", max_amount: "0.10", seller: "profile-seller" };

function setup(hsp: MockHsp) {
  const secret = randomBytes(32);
  const dir = mkdtempSync(join(tmpdir(), "cs-confirm-"));
  const tasks = new TaskStore(join(dir, "tasks"));
  const signer = createSigner({
    account: agent,
    policy,
    ticketSecret: secret,
    extras: (_o, i, agentId) => ({ task: tasks.extraFor((i as { task_id?: string }).task_id, agentId) }),
  });
  const port: SignerPort = { address: () => signer.handle({ op: "address" }), signPayment: (t, td) => signer.handle({ op: "sign_payment", ticket: t, typedData: td }) };
  const history = new HistoryStore(join(dir, "h.jsonl"));
  const w = new WalletService({
    hsp,
    signer: port,
    policy,
    ticketSecret: secret,
    ledger: new MemorySpendLedger(),
    history,
    tasks,
    pause: () => ({ paused: false, at: 0 }),
    hspMode: "mock",
    pollIntervalMs: 0,
    pollTimeoutMs: 0,
  });
  return { w, history, tasks };
}

describe("결제 상태: 확정만 paid", () => {
  it("확인 시간 안에 확정이 안 되면 confirming, 맡긴 일은 paid가 아님 → check_payment로 이어서 확정", async () => {
    const hsp = new MockHsp({ chainId: 133, token: USDC });
    const { w, history, tasks } = setup(hsp);
    const task = tasks.create("x", 100_000n, 1);
    const o = await hsp.createOrder({ pay_to: SELLER, amount: "100000", chain_id: 133, token: USDC });
    const r = await w.payOrder({ order_ref: o.order_ref, intent: { ...intent, task_id: task.id } });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, hsp_status: "submitted" });
    expect(history.list(1)[0]).toMatchObject({ status: "confirming", payment_id: expect.any(String) });
    expect(tasks.get(task.id)!.status).toBe("working");

    // 같은 주문을 다시 pay_order 해도 다시 서명하지 않는다
    expect(await w.payOrder({ order_ref: o.order_ref, intent })).toMatchObject({ ok: false, code: "DUPLICATE" });

    const c1 = await w.checkPayment(o.order_ref);
    expect(c1, JSON.stringify(c1)).toMatchObject({ hsp_status: "payment-safe" });
    expect(history.list(1)[0].status).toBe("confirming");
    expect(await w.checkPayment(o.order_ref)).toMatchObject({ ok: true, hsp_status: "payment-finalized" });
    const all = history.list(10);
    expect(all.filter((e) => e.order_ref === o.order_ref)).toHaveLength(2); // 결제 1건(갱신됨) + DUPLICATE 거절 1건
    expect(all.find((e) => e.order_ref === o.order_ref && e.status === "paid")).toBeTruthy();
    expect(tasks.get(task.id)!.status).toBe("paid");
  });

  it("제출 뒤 조회가 끊기면 PAYMENT_UNCONFIRMED + confirming (failed로 쓰지 않음)", async () => {
    const hsp = new MockHsp({ chainId: 133, token: USDC });
    const { w, history } = setup(hsp);
    hsp.queryPayment = async () => {
      throw new Error("network down");
    };
    const o = await hsp.createOrder({ pay_to: SELLER, amount: "100000", chain_id: 133, token: USDC });
    expect(await w.payOrder({ order_ref: o.order_ref, intent })).toMatchObject({ ok: false, code: "PAYMENT_UNCONFIRMED" });
    expect(history.list(1)[0]).toMatchObject({ status: "confirming", code: "PAYMENT_UNCONFIRMED" });
  });

  it("HSP가 서명을 받지 않으면(finalize 실패) failed: 돈이 나가지 않음", async () => {
    const hsp = new MockHsp({ chainId: 133, token: USDC });
    const { w, history } = setup(hsp);
    hsp.finalizePayment = async () => {
      throw new Error("rejected");
    };
    const o = await hsp.createOrder({ pay_to: SELLER, amount: "100000", chain_id: 133, token: USDC });
    expect(await w.payOrder({ order_ref: o.order_ref, intent })).toMatchObject({ ok: false, code: "HSP_ERROR" });
    expect(history.list(1)[0]).toMatchObject({ status: "failed" });
  });
});
