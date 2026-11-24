import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueTicket, normalizeOrder, verifyPayment, type VerifiedPayment } from "@countersign/wallet-core";
import { EVIL, NOW, agent, intent, policy, setup } from "@countersign/wallet-core/testkit";
import { describe, expect, it } from "vitest";
import { SignerClient } from "./client.js";
import { listen } from "./server.js";
import { createSigner } from "./signer.js";

const secret = randomBytes(32);

/** 지갑(검증기) 쪽이 하는 일을 흉내: 검증 통과 → 티켓 발급 */
async function walletSide(opts: Parameters<typeof setup>[0] = {}) {
  const s = await setup(opts);
  const v = verifyPayment({ order: s.order, intent, policy, ledger: s.ledger, typedData: s.typedData, agent: agent.address, now: NOW });
  if (!v.ok) throw new Error(`wallet check failed: ${v.code}`);
  const ticket = issueTicket(secret, { typedDataHash: (v as VerifiedPayment).typedDataHash, order: s.order, intent: v.intent, now: NOW });
  return { ...s, ticket };
}

const newSigner = (now = NOW) => createSigner({ account: agent, policy, ticketSecret: secret, now: () => now });

describe("signer", () => {
  it("검증 티켓이 있으면 서명하고, HSP mock finalize가 그 서명을 받아들인다", async () => {
    const w = await walletSide();
    const r = await newSigner().handle({ op: "sign_payment", ticket: w.ticket, typedData: w.typedData });
    expect(r).toMatchObject({ ok: true, op: "sign_payment" });
    if (r.ok && r.op === "sign_payment") {
      const fin = await w.hsp.finalizePayment(w.order.orderRef, r.signature);
      expect(fin.payment_id).toMatch(/^mock_pay_/);
    }
  });

  it("티켓 없이, 위조, 만료, 재사용이면 서명하지 않는다", async () => {
    const w = await walletSide();
    const s = newSigner();
    expect(await s.handle({ op: "sign_payment", ticket: null, typedData: w.typedData })).toMatchObject({ code: "TICKET_INVALID" });
    const forged = { ...w.ticket, mac: "0".repeat(64) };
    expect(await s.handle({ op: "sign_payment", ticket: forged, typedData: w.typedData })).toMatchObject({ code: "TICKET_INVALID" });
    const otherKey = issueTicket(randomBytes(32), { typedDataHash: w.ticket.typedDataHash, order: w.order, intent: w.ticket.intent as never, now: NOW });
    expect(await s.handle({ op: "sign_payment", ticket: otherKey, typedData: w.typedData })).toMatchObject({ code: "TICKET_INVALID" });
    expect(await newSigner(NOW + 61).handle({ op: "sign_payment", ticket: w.ticket, typedData: w.typedData })).toMatchObject({
      code: "TICKET_INVALID",
    });
    expect((await s.handle({ op: "sign_payment", ticket: w.ticket, typedData: w.typedData })).ok).toBe(true);
    expect(await s.handle({ op: "sign_payment", ticket: w.ticket, typedData: w.typedData })).toMatchObject({
      code: "TICKET_INVALID",
      reason: "이미 쓴 티켓",
    });
  });

  it("티켓은 진짜인데 typed data를 바꿔 보내면 거부 (티켓 해시와 다름)", async () => {
    const a = await walletSide();
    const b = await walletSide(); // 같은 주문 형태, nonce만 다름
    expect(await newSigner().handle({ op: "sign_payment", ticket: a.ticket, typedData: b.typedData })).toMatchObject({
      code: "TICKET_INVALID",
    });
  });

  it("지갑 쪽이 뚫려 정책 밖 티켓을 발급해도 signer가 다시 검사해서 막는다", async () => {
    const s = await setup({ payTo: EVIL });
    const order = normalizeOrder(await s.hsp.getOrder(s.order.orderRef));
    // 검증 없이 바로 티켓 발급 (뚫린 지갑 흉내)
    const { typedDataHash, parseTypedData } = await import("@countersign/wallet-core");
    const td = parseTypedData(s.typedData);
    if (!td.ok) throw new Error("parse");
    const ticket = issueTicket(secret, { typedDataHash: typedDataHash(td.td), order, intent, now: NOW });
    expect(await newSigner().handle({ op: "sign_payment", ticket, typedData: s.typedData })).toMatchObject({
      code: "PAYEE_MISMATCH",
    });
  });

  it("signer 자체 지출 기록으로 일일 한도를 지킨다", async () => {
    const s = newSigner();
    const { MockHsp } = await import("@countersign/hsp");
    const { CHAIN, USDC } = await import("@countersign/wallet-core/testkit");
    const hsp = new MockHsp({ chainId: CHAIN, token: USDC, now: () => NOW }); // 주문 번호가 겹치지 않게 하나를 공유
    for (let i = 0; i < 5; i++) {
      const w = await walletSide({ amount: "200000", hsp });
      expect((await s.handle({ op: "sign_payment", ticket: w.ticket, typedData: w.typedData })).ok).toBe(true);
    }
    const w = await walletSide({ amount: "100", hsp }); // 1.00 USDC를 이미 다 씀
    expect(await s.handle({ op: "sign_payment", ticket: w.ticket, typedData: w.typedData })).toMatchObject({
      code: "OVER_LIMIT",
    });
  });

  it("정책을 함수로 주면 서명 때마다 다시 읽는다: 판매자를 빼면 바로 거부, 정책을 못 읽으면 POLICY_INVALID", async () => {
    let current = policy;
    const s = createSigner({ account: agent, policy: () => current, ticketSecret: secret, now: () => NOW });
    const w = await walletSide();
    current = { ...policy, sellers: new Map() };
    expect(await s.handle({ op: "sign_payment", ticket: w.ticket, typedData: w.typedData })).toMatchObject({ code: "PAYEE_MISMATCH" });
    const w2 = await walletSide();
    current = { ...policy, accountIndex: 2 };
    expect(await s.handle({ op: "sign_payment", ticket: w2.ticket, typedData: w2.typedData })).toMatchObject({ code: "POLICY_INVALID" });
    const broken = createSigner({
      account: agent,
      policy: (() => {
        let n = 0;
        return () => {
          if (n++ > 0) throw new Error("broken");
          return policy;
        };
      })(),
      ticketSecret: secret,
      now: () => NOW,
    });
    expect(await broken.handle({ op: "sign_payment", ticket: w2.ticket, typedData: w2.typedData })).toMatchObject({ code: "POLICY_INVALID" });
  });

  it("임의 서명·키 내보내기 같은 요청은 없다", async () => {
    const s = newSigner();
    for (const op of ["sign_raw", "sign_message", "export_key", "set_policy"]) {
      expect(await s.handle({ op, data: "0x00" })).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(await s.handle({ op: "address" })).toEqual({ ok: true, op: "address", address: agent.address });
  });

  it("유닉스 소켓으로 왕복하고, 소켓 파일 권한은 0600", async () => {
    const path = join(tmpdir(), `countersign-test-${randomBytes(4).toString("hex")}`, "signer.sock");
    const server = await listen(newSigner(), path);
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const c = new SignerClient(path);
      expect(await c.address()).toMatchObject({ ok: true, address: agent.address });
      const w = await walletSide();
      expect(await c.signPayment(w.ticket, w.typedData)).toMatchObject({ ok: true, op: "sign_payment" });
    } finally {
      server.close();
    }
  });
});
