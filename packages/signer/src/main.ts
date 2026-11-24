#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveAccount, parsePolicy, parseTicketSecret } from "@countersign/wallet-core";
import { loadSecret } from "./keysource.js";
import { listen } from "./server.js";
import { createSigner } from "./signer.js";

/**
 * signer 실행: COUNTERSIGN_POLICY=정책.json COUNTERSIGN_TICKET_SECRET=... pnpm --filter @countersign/signer start
 * 개발 니모닉(OURYN_DEV_MNEMONIC)의 정책 accountIndex번 계정으로만 서명한다.
 * 메인넷 배포 키(OURYN_DEPLOYER_KEY)는 읽지 않는다 (메인넷 키로 테스트하지 않음).
 */
async function main() {
  const policyPath = process.env.COUNTERSIGN_POLICY;
  if (!policyPath) throw new Error("COUNTERSIGN_POLICY(정책 파일 경로)가 필요함");
  const policy = parsePolicy(JSON.parse(readFileSync(policyPath, "utf8")));
  const ticketSecret = parseTicketSecret(loadSecret("COUNTERSIGN_TICKET_SECRET"));
  const account = deriveAccount(loadSecret("OURYN_DEV_MNEMONIC"), policy.accountIndex);
  const socketPath = process.env.COUNTERSIGN_SIGNER_SOCKET || join(homedir(), ".countersign", "signer.sock");

  const server = await listen(createSigner({ account, policy, ticketSecret }), socketPath);
  // 주소와 소켓 경로만 출력한다 (공개값)
  console.log(`countersign-signer: ${policy.agent} 계정 #${policy.accountIndex} ${account.address}`);
  console.log(`countersign-signer: ${socketPath} 에서 대기`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => {
  console.error(`countersign-signer 시작 실패: ${e instanceof Error ? e.message : "알 수 없는 오류"}`);
  process.exit(1);
});
