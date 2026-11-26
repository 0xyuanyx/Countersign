#!/usr/bin/env -S npx tsx
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { statePaths } from "@countersign/wallet-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { taskPrompt } from "./prompt.js";

/**
 * 맡긴 일 실행기: 주인이 폰에서 맡긴 일을 받아(next_task) 에이전트 CLI(Claude Code `claude -p`, 또는 Codex `codex exec`)로
 * 실제로 처리하게 한다. 에이전트는 이 에이전트 연결의 지갑 MCP로만 결제한다 (키·정책은 지갑 쪽에 있다).
 *
 *   node_modules/.bin/tsx apps/runner/src/main.ts <에이전트 이름 또는 id> [--cli claude|codex]
 *
 * - 주인 API(COUNTERSIGN_OWNER_API, 기본 http://127.0.0.1:7420)에 주인 토큰(~/.countersign/owner.token)으로
 *   그 에이전트의 실행기 주소를 받는다. 앱에 보이는 연결 주소는 그대로 둔다.
 * - 10초마다 next_task를 확인하고, 일이 있으면 CLI를 한 번 돌린다 (최대 15분). CLI가 finish_task를 안 부르면 실행기가 실패로 보고한다.
 * - 토큰·주소는 출력하지 않는다.
 */
const args = process.argv.slice(2);
const who = args.find((a) => !a.startsWith("--"));
const cli = (args.includes("--cli") ? args[args.indexOf("--cli") + 1] : process.env.COUNTERSIGN_RUNNER_CLI) || "claude";
if (!who || (cli !== "claude" && cli !== "codex")) {
  console.error("사용법: tsx apps/runner/src/main.ts <에이전트 이름 또는 id> [--cli claude|codex]");
  process.exit(1);
}
const api = (process.env.COUNTERSIGN_OWNER_API || "http://127.0.0.1:7420").replace(/\/+$/, "");
// 상태 폴더: COUNTERSIGN_HOME → 없으면 demo.sh와 같은 저장소 .countersign → ~/.countersign
const repoHome = join(fileURLToPath(new URL("../../..", import.meta.url)), ".countersign");
const home = process.env.COUNTERSIGN_HOME || (existsSync(join(repoHome, "owner.token")) ? repoHome : undefined);
const ownerToken = process.env.COUNTERSIGN_OWNER_TOKEN || readFileSync(statePaths(home ? { COUNTERSIGN_HOME: home } : process.env).ownerToken, "utf8").trim();
const auth = { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" };
const POLL_MS = Number(process.env.COUNTERSIGN_RUNNER_POLL_MS || 10_000);
const TASK_TIMEOUT_MS = 15 * 60_000;

const agents = ((await (await fetch(`${api}/api/agents`, { headers: auth })).json()) as { agents?: { id: string; name: string; active: boolean }[] }).agents ?? [];
const agent = agents.find((a) => (a.id === who || a.name === who) && a.active);
if (!agent) {
  console.error(`살아 있는 에이전트 "${who}"를 찾지 못함 (앱의 에이전트 이름이나 id)`);
  process.exit(1);
}
const r = await fetch(`${api}/api/agents/${agent.id}/runner`, { method: "POST", headers: auth, body: "{}" });
if (!r.ok) {
  console.error(`실행기 주소를 받지 못함 (HTTP ${r.status})`);
  process.exit(1);
}
const { url } = (await r.json()) as { url: string };

const client = new Client({ name: `countersign-runner-${agent.name}`, version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const call = async (name: string, a: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: a });
  return JSON.parse((res.content as { text: string }[])[0]!.text) as Record<string, any>;
};

// CLI용 MCP 설정 (토큰이 든 주소라 0600 임시 폴더에 두고 끝나면 지운다)
const dir = mkdtempSync(join(tmpdir(), "cs-runner-"));
const mcpConfig = join(dir, "mcp.json");
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { countersign: { type: "http", url } } }), { mode: 0o600 });
const cleanup = () => rmSync(dir, { recursive: true, force: true });
process.on("SIGINT", () => (cleanup(), process.exit(0)));
process.on("SIGTERM", () => (cleanup(), process.exit(0)));

console.log(`countersign-runner: ${agent.name} 의 맡긴 일을 기다리는 중 (${cli}, ${POLL_MS / 1000}초마다)`);

function runCli(prompt: string): Promise<number> {
  const [cmd, cmdArgs] =
    cli === "claude"
      ? [
          "claude",
          ["-p", prompt, "--mcp-config", mcpConfig, "--strict-mcp-config", "--allowedTools", "mcp__countersign__pay_order", "mcp__countersign__get_policy", "mcp__countersign__get_balance", "mcp__countersign__get_history", "mcp__countersign__finish_task", "Bash(curl:*)", "Bash(sleep:*)"],
        ]
      : [
          "codex",
          [
            "exec",
            "--skip-git-repo-check",
            "-s",
            "workspace-write",
            "-c",
            "sandbox_workspace_write.network_access=true",
            // 이 에이전트 연결로만 결제하게: 전역에 등록된 countersign(로컬 1번)은 끄고, 실행기 주소를 따로 붙인다
            "-c",
            "mcp_servers.countersign.enabled=false",
            "-c",
            `mcp_servers.cs_runner.url="${url}"`,
            // 지갑 도구 호출 승인: 결제 판단은 지갑과 주인(폰 승인)이 한다
            "-c",
            'mcp_servers.cs_runner.default_tools_approval_mode="approve"',
            prompt,
          ],
        ];
  return new Promise((resolve) => {
    const child = spawn(cmd as string, cmdArgs as string[], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), TASK_TIMEOUT_MS);
    child.on("exit", (code) => (clearTimeout(timer), resolve(code ?? 1)));
    child.on("error", () => (clearTimeout(timer), resolve(127)));
  });
}

for (;;) {
  try {
    const next = await call("next_task");
    if (next.task) {
      const task = next.task as { id: string; text: string; max_amount: string };
      console.log(`\n▶ 일 시작 ${task.id}: ${task.text}`);
      const code = await runCli(taskPrompt(task));
      // 에이전트가 보고를 안 하고 끝났으면 실행기가 실패로 남긴다 (이미 보고했으면 finish_task가 상태만 덮지 않게 확인)
      const tasks = ((await (await fetch(`${api}/api/tasks?agentId=${agent.id}`, { headers: auth })).json()) as { tasks?: { id: string; status: string }[] }).tasks ?? [];
      const st = tasks.find((t) => t.id === task.id)?.status;
      if (st === "open" || st === "working") {
        await call("finish_task", { task_id: task.id, status: "failed", note: `에이전트가 보고 없이 끝남 (종료 코드 ${code})` });
      }
      console.log(`■ 일 끝 ${task.id}: ${st ?? "?"}`);
    }
  } catch (e) {
    console.error(`실행기 오류: ${e instanceof Error ? e.message.split("\n")[0] : "알 수 없음"}`);
  }
  await new Promise((res) => setTimeout(res, POLL_MS));
}
