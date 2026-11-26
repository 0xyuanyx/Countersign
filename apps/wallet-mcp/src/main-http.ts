#!/usr/bin/env -S npx tsx
import { SeenStore } from "@countersign/wallet-core";
import { createWalletHttp, listenWalletHttp } from "./http.js";
import { walletFromEnv } from "./setup.js";

/**
 * 원격 지갑 MCP 실행: (stdio와 같은 환경변수) + COUNTERSIGN_WALLET_HTTP_PORT(기본 7440), COUNTERSIGN_WALLET_HTTP_HOST(기본 127.0.0.1)
 * 연결 주소·토큰은 주인 API(POST /api/agents)가 만든다. 밖에서 닿게 하려면 HTTPS 터널·프록시를 앞에 둔다.
 */
const { walletFor, registry, policy, paths } = await walletFromEnv();
const url = await listenWalletHttp(
  createWalletHttp(walletFor, registry.connections, new SeenStore(paths.seen)),
  Number(process.env.COUNTERSIGN_WALLET_HTTP_PORT || 7440),
  process.env.COUNTERSIGN_WALLET_HTTP_HOST || "127.0.0.1",
);
console.log(`countersign-wallet-http: ${url}/mcp/<토큰> (${policy.agent})`);
