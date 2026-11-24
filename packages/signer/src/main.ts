#!/usr/bin/env -S npx tsx
import {
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
  const account = deriveAccount(loadSecret("OURYN_DEV_MNEMONIC"), policy.accountIndex);
  const socketPath = paths.signerSocket;

  const approvals = new ApprovalStore(paths.approvals);
  const tasks = new TaskStore(paths.tasks);
  const signer = createSigner({
    account,
    policy: () => policyFile.get(),
    ticketSecret,
    ledger: new FileSpendLedger(paths.signerLedger),
    pause: () => readPause(paths.pause),
    extras: (orderRef, intent) => ({
      approval: approvals.approvalFor(orderRef),
      task: tasks.extraFor(taskIdOf(intent)),
    }),
  });
  const server = await listen(signer, socketPath);
  // 주소와 소켓 경로만 출력한다 (공개값)
  console.log(`countersign-signer: ${policy.agent} 계정 #${policy.accountIndex} ${account.address}`);
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
