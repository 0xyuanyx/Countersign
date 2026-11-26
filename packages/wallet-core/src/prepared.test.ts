import { describe, expect, it } from "vitest";
import { checkPrepared, parseTypedData } from "./evidence.js";
import { EVIL, agent, setup, stranger } from "./testkit.js";

/** prepare_payment가 eip712와 같이 준 값(가이드 §7)의 변조 (수취인·payer·금액·가스 부담) */
describe("checkPrepared", () => {
  it("값이 서명 대상과 같으면 통과, 하나라도 다르면 TYPED_DATA_MISMATCH", async () => {
    const s = await setup();
    const td = parseTypedData(s.typedData);
    if (!td.ok) throw new Error("parse");
    const ok = { pay_to: td.td.message.to, payer: agent.address, token_total_raw: td.td.message.value.toString(), gas_fee_advanced: true };
    expect(checkPrepared(ok, td.td, agent.address).ok).toBe(true);
    for (const bad of [
      { ...ok, pay_to: EVIL },
      { ...ok, payer: stranger.address },
      { ...ok, token_total_raw: (td.td.message.value + 1n).toString() },
      { ...ok, token_total_raw: "lots" },
      { ...ok, gas_fee_advanced: false },
    ]) {
      expect(checkPrepared(bad, td.td, agent.address)).toMatchObject({ ok: false, code: "TYPED_DATA_MISMATCH" });
    }
  });
});
