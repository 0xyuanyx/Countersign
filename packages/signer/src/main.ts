#!/usr/bin/env -S npx tsx
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  AgentRegistry,
  ApprovalStore,
  FileSpendLedger,
  TaskStore,
  PolicyFile,
  deriveAccount,
  parseTicketSecret,
  readOrCreateSharedSecret,
  readPause,
  statePaths,
} from "@countersign/wallet-core";
import { loadSecret } from "./keysource.js";
import { listen } from "./server.js";
import { createSigner } from "./signer.js";
import { makeWithdraw } from "./withdraw.js";
import { registryAgents } from "./agents.js";

/**
 * signer 실행: COUNTERSIGN_POLICY=정책.json pnpm --filter @countersign/signer start
 * 상태 폴더(~/.countersign, COUNTERSIGN_HOME)에 소켓·지출 기록·티켓 키 파일을 둔다.
 * 개발 니모닉(OURYN_DEV_MNEMONIC)의 정책 accountIndex번 계정으로만 서명한다.
 * 메인넷 배포 키(OURYN_DEPLOYER_KEY)는 읽지 않는다 (메인넷 키로 테스트하지 않음).
 */
async function main() {
  const policyPath = process.env.COUNTERSIGN_POLICY;
  if (!policyPath) throw new Error("COUNTERSIGN_POLICY(정책 파일 경로)가 필요함");
  const policyFile = new PolicyFile(policyPath);
  const policy = policyFile.get();
  const paths = statePaths();
  // 검증 티켓 HMAC 키: 환경변수가 없으면 signer가 만들어 0600 파일로 둔다 (지갑 MCP가 같은 파일을 읽는다)
  const ticketSecret = parseTicketSecret(
    process.env.COUNTERSIGN_TICKET_SECRET || readOrCreateSharedSecret(paths.ticketSecret, true),
  );
  if (policy.accountIndex !== 1) throw new Error("COUNTERSIGN_POLICY는 첫 에이전트(1번 계정) 정책이어야 함");
  // 니모닉은 이 프로세스 안에서만 들고, 에이전트 계정을 필요할 때 파생한다 (밖으로 내보내는 길은 없다)
  const derive = (() => {
    const mnemonic = loadSecret("OURYN_DEV_MNEMONIC");
    const cache = new Map<number, ReturnType<typeof deriveAccount>>();
    return (index: number) => {
      let a = cache.get(index);
      if (!a) cache.set(index, (a = deriveAccount(mnemonic, index)));
      return a;
    };
  })();
  const account = derive(1);
  const owner = derive(0); // 주인 계정: 출금 받는 곳 + 출금 거래 가스
  const socketPath = paths.signerSocket;
  const registry = new AgentRegistry(paths, policyPath);
  const approvals = new ApprovalStore(paths.approvals);
  const tasks = new TaskStore(paths.tasks);
  const signer = createSigner({
    account,
    policy: () => policyFile.get(),
    ticketSecret,
    ledger: new FileSpendLedger(paths.signerLedger),
    agents: registryAgents(registry, derive),
    withdraw: {
      checkOwnerToken: (t) => {
        const expected = process.env.COUNTERSIGN_OWNER_TOKEN || readOrCreateSharedSecret(paths.ownerToken, false);
        return !!expected && t.length === expected.length && timingSafeEqual(Buffer.from(t), Buffer.from(expected));
      },
      run: makeWithdraw(owner, { dir: join(paths.dir, "withdrawals") }),
    },
    pause: () => readPause(paths.pause),
    extras: (orderRef, intent, agentId) => ({
      approval: approvals.approvalFor(orderRef, agentId),
      task: tasks.extraFor(taskIdOf(intent), agentId),
    }),
  });
  const server = await listen(signer, socketPath);
  // 주소와 소켓 경로만 출력한다 (공개값)
  console.log(`countersign-signer: 첫 에이전트 계정 #1 ${account.address}, 주인 #0 ${owner.address}`);
  console.log(`countersign-signer: ${socketPath} 에서 대기`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function taskIdOf(intent: unknown): string | undefined {
  const v = intent && typeof intent === "object" ? (intent as Record<string, unknown>).task_id : undefined;
  return typeof v === "string" ? v : undefined;
}

main().catch((e: unknown) => {
  console.error(`countersign-signer 시작 실패: ${e instanceof Error ? e.message : "알 수 없는 오류"}`);
  process.exit(1);
});
