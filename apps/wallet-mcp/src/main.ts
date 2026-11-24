#!/usr/bin/env -S npx tsx
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, walletFromEnv } from "./setup.js";

/**
 * 지갑 MCP 서버 (stdio). Claude Code·Codex CLI 같은 에이전트가 자식 프로세스로 띄운다.
 * 키를 읽지 않는다 (AGENTS.md 규칙 6). 서명은 signer 소켓에 부탁한다. signer를 먼저 켜 둬야 한다.
 * stdout은 MCP 통신용이라 로그는 stderr로만 쓴다. 원격(HTTP)은 main-http.ts.
 */
async function main() {
  const { wallet, policy, hspConfig } = await walletFromEnv();
  await buildMcpServer(wallet, process.env.COUNTERSIGN_AGENT_NAME || "local").connect(new StdioServerTransport());
  console.error(`countersign-wallet-mcp: ${policy.agent}, HSP ${hspConfig.mode}, 체인 ${[...policy.chains].join(",")}`);
}

main().catch((e: unknown) => {
  console.error(`countersign-wallet-mcp 시작 실패: ${e instanceof Error ? e.message : "알 수 없는 오류"}`);
  process.exit(1);
});
