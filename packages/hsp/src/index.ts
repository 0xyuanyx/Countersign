export * from "./canonical.js";
export * from "./config.js";
export * from "./types.js";
export { MockHsp, type MockHspOptions } from "./mock.js";
export { McpHspClient } from "./mcp-client.js";

import { loadHspConfig, type HspConfig } from "./config.js";
import { McpHspClient } from "./mcp-client.js";
import { MockHsp } from "./mock.js";
import { KNOWN_USDC, KNOWN_USDC_NAME } from "./config.js";
import type { HspClient } from "./types.js";

/** 설정값으로 HSP 클라이언트를 만든다. mock이면 결제 체인의 USDC 주소가 필요하다. */
export async function createHspClient(config: HspConfig = loadHspConfig()): Promise<HspClient> {
  const url = config.mcpUrl;
  if (!url) {
    const token = KNOWN_USDC[config.payChainId];
    if (!token) throw new Error(`mock: 체인 ${config.payChainId}의 USDC 주소를 모름`);
    return new MockHsp({ chainId: config.payChainId, token, tokenName: KNOWN_USDC_NAME[config.payChainId] ?? "USD Coin" });
  }
  const c = new McpHspClient(url);
  await c.connect();
  return c;
}
export { serveMockHsp, type MockHspServer } from "./mock-server.js";
