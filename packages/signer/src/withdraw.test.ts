import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySpendLedger, deriveAccount } from "@countersign/wallet-core";
import { TEST_WORDS, policy } from "@countersign/wallet-core/testkit";
import { describe, expect, it } from "vitest";
import { makeWithdraw } from "./withdraw.js";

/** 출금 중복 방지 (11/27 리뷰 P2-6). RPC에 닿지 않는 경로만 검사한다 (RPC 주소는 일부러 없는 곳) */
const owner = deriveAccount(TEST_WORDS, 0);
const agentAcct = deriveAccount(TEST_WORDS, 1);
const agent = { account: agentAcct, accountIndex: 1, policy, ledger: new MemorySpendLedger() };
const env = { COUNTERSIGN_RPC_133: "http://127.0.0.1:9" } as NodeJS.ProcessEnv;

function dirWith(records: object[]) {
  const dir = join(mkdtempSync(join(tmpdir(), "cs-wd-")), "withdrawals");
  mkdirSync(dir, { recursive: true });
  for (const r of records) writeFileSync(join(dir, `${(r as { id: string }).id}.json`), JSON.stringify(r));
  return dir;
}

describe("출금 중복 방지", () => {
  it("같은 요청 id가 이미 끝났으면 새로 보내지 않고 그 결과를 돌려준다", async () => {
    const done = { id: "wd_same_0001", agent_id: "local", status: "done", at: 1, chain_id: 133, token: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6", from: agentAcct.address, to: owner.address, amount: "10000", tx_hash: `0x${"cd".repeat(32)}` };
    const run = makeWithdraw(owner, { dir: dirWith([done]), env });
    expect(await run(agent, 10_000n, "wd_same_0001", "local")).toMatchObject({ ok: true, status: "done", tx_hash: done.tx_hash });
    // 다른 에이전트가 같은 id를 쓰면 거절
    expect(await run(agent, 10_000n, "wd_same_0001", "agent_other")).toMatchObject({ ok: false, code: "WITHDRAW_FAILED" });
  });

  it("같은 에이전트에 아직 영수증 전인 출금이 있으면 새 출금을 거절", async () => {
    const sent = { id: "wd_inflight_01", agent_id: "local", status: "sent", at: Math.floor(Date.now() / 1000), amount: "1", tx_hash: `0x${"ef".repeat(32)}` };
    const run = makeWithdraw(owner, { dir: dirWith([sent]), env });
    const r = await run(agent, 1n, "wd_new_000001", "local");
    expect(r).toMatchObject({ ok: false, code: "WITHDRAW_FAILED" });
    expect((r as { reason: string }).reason).toMatch(/이전 출금/);
  });

  it("실패한 요청 id를 다시 보내면 실패를 그대로 (다시 보내지 않음)", async () => {
    const failed = { id: "wd_failed_001", agent_id: "local", status: "failed", at: 1, reason: "잔액보다 많이 출금할 수 없음" };
    const run = makeWithdraw(owner, { dir: dirWith([failed]), env });
    expect(await run(agent, 1n, "wd_failed_001", "local")).toMatchObject({ ok: false, reason: "잔액보다 많이 출금할 수 없음" });
  });
});
