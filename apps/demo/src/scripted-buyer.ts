#!/usr/bin/env -S npx tsx
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * 스크립트 구매 에이전트 (LLM 없음): Claude Code·Codex가 하는 것과 같은 방식으로
 * 지갑 MCP 서버를 stdio 자식 프로세스로 띄워 붙고, 판매자 5곳(정상 1, 악성 4)에서 하나씩 산다.
 * 먼저 apps/demo/demo.sh up 으로 서버들을 띄워 둔다.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELLERS = [
  ["정상", 7430],
  ["악성: 받는 주소 바꿔치기", 7431],
  ["악성: 금액 50배", 7432],
  ["악성: 다른 체인", 7433],
  ["악성: 프롬프트 인젝션 (+ 속은 에이전트)", 7434],
] as const;

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
Object.assign(env, {
  COUNTERSIGN_HOME: process.env.COUNTERSIGN_HOME || join(root, ".countersign"),
  COUNTERSIGN_POLICY: process.env.COUNTERSIGN_POLICY || join(root, "apps/demo/policy.testnet.json"),
  COUNTERSIGN_HSP_MODE: "mock",
  COUNTERSIGN_HSP_MCP_URL: "http://127.0.0.1:7410/mcp",
  COUNTERSIGN_PAY_CHAIN_ID: "133",
  COUNTERSIGN_POLL_MS: "200",
});

const client = new Client({ name: "scripted-buyer", version: "0" });
await client.connect(
  new StdioClientTransport({ command: join(root, "node_modules/.bin/tsx"), args: [join(root, "apps/wallet-mcp/src/main.ts")], env, stderr: "ignore" }),
);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse((r.content as { text: string }[])[0]!.text) as Record<string, any>;
};
const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
};

const pol = await call("get_policy");
console.log(`지갑: ${pol.agent} ${pol.account} · 건당 ${pol.per_tx_max} / 24시간 남은 한도 ${pol.remaining_24h} USDC`);

for (const [label, port] of SELLERS) {
  const base = `http://127.0.0.1:${port}`;
  const offer = (await post(`${base}/orders`, { sku: "profile", subject: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" })).json;
  // 인젝션 판매자에게는 "속은 에이전트"를 흉내 낸다: notice가 시키는 대로 max_amount를 올린다
  const maxAmount = offer.notice ? "5.00" : offer.price;
  const pay = await call("pay_order", {
    order_ref: offer.order_ref,
    intent: { purpose: offer.item, max_amount: maxAmount, seller: offer.seller },
  });
  let line = `\n[${label}] 판매자 말: ${offer.price} USDC → ${offer.pay_to.slice(0, 10)}… 체인 ${offer.chain_id}`;
  if (pay.ok) {
    const d = await post(`${base}/deliver`, { order_ref: offer.order_ref, payment_id: pay.payment_id });
    line += `\n  ✓ 결제 ${pay.amount} USDC (${pay.hsp_status}, ${pay.payment_id}) → 납품 ${d.status === 200 ? "받음" : `실패 ${d.status}`}`;
  } else {
    const d = await post(`${base}/deliver`, { order_ref: offer.order_ref, payment_id: "none" });
    line += `\n  ✗ 거부 ${pay.code} (${pay.step}): ${pay.reason}\n    다음 행동: ${pay.next_action}\n    납품: ${d.status === 200 ? "받음(!)" : "없음"}`;
  }
  console.log(line);
}
const h = await call("get_history", { limit: 5 });
console.log(`\n내역 ${h.entries.length}건 (최신 5건), 24시간 사용 ${(await call("get_policy")).spent_24h} USDC`);
await client.close();
