import { z } from "zod";

/**
 * 결제 체인과 HSP 주소는 운영진 답(§9 #1·#2)이 오기 전까지 설정값으로 둔다.
 * 코드 어디에도 "결제는 이 체인" 같은 상수를 박지 않는다.
 */
export const HspConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("mock"),
    /** 기본 Ethereum Sepolia: 해커톤 공식 테스트 USDC가 있는 곳 (운영진 11/26 답). HSK 테스트넷은 133 */
    payChainId: z.number().int().positive().default(11155111),
    /**
     * 비우면 프로세스 안 mock. 판매 서버와 지갑이 같은 mock을 써야 하면
     * HSP mock 서버(pnpm --filter @countersign/hsp mock) 주소 http://127.0.0.1:7410/mcp 를 넣는다.
     */
    mcpUrl: z.url().refine(isLoopbackHttp, "mock 서버 주소는 http://127.0.0.1 만").optional(),
  }),
  z.object({
    mode: z.literal("mcp"),
    /** 예: QA https://mcp-qa.hashkeymerchant.com/ (IP 허용 목록 필요) */
    mcpUrl: z.url().refine((u) => u.startsWith("https://"), "https만 허용"),
    payChainId: z.number().int().positive(),
  }),
]);
export type HspConfig = z.infer<typeof HspConfigSchema>;

export function loadHspConfig(env: NodeJS.ProcessEnv = process.env): HspConfig {
  const mode = env.COUNTERSIGN_HSP_MODE ?? "mock";
  const payChainId = env.COUNTERSIGN_PAY_CHAIN_ID ? Number(env.COUNTERSIGN_PAY_CHAIN_ID) : undefined;
  return HspConfigSchema.parse({ mode, mcpUrl: env.COUNTERSIGN_HSP_MCP_URL || undefined, payChainId });
}

/**
 * 공개 토큰 주소 (PROJECT.md §4.3). 다른 체인은 정책 파일 tokenAddresses로 넣는다.
 * 실제 결제에서는 HSP get_chain_config 값이 기준이다 (AGENTS.md 규칙 9). 이 표는 정책 기본값·mock용.
 */
export const KNOWN_USDC: Readonly<Record<number, `0x${string}`>> = {
  /** Ethereum Sepolia, Circle 공식 테스트 USDC (developers.circle.com 주소표, 11/26 체인 조회: name "USDC", version "2") */
  11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  177: "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
  133: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6",
};

/** EIP-712 domain 이름 (mock용). Circle Sepolia USDC는 "USDC", HSK 쪽은 "USD Coin" */
export const KNOWN_USDC_NAME: Readonly<Record<number, string>> = { 11155111: "USDC", 177: "USD Coin", 133: "USD Coin" };

/** 실서버는 https만. 같은 컴퓨터의 HSP mock 서버(serveMockHsp)만 http 루프백을 허용한다. */
export function isAllowedHspUrl(u: string): boolean {
  return u.startsWith("https://") || isLoopbackHttp(u);
}

export function isLoopbackHttp(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** 공개 RPC (읽기·출금용). 다른 체인은 COUNTERSIGN_RPC_<chainId> 환경변수로 */
export const KNOWN_RPC: Readonly<Record<number, string>> = {
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  177: "https://mainnet.hsk.xyz",
  133: "https://testnet.hsk.xyz",
};

/** 블록 탐색기 (주소·tx 링크용) */
export const KNOWN_EXPLORER: Readonly<Record<number, string>> = {
  11155111: "https://eth-sepolia.blockscout.com",
  177: "https://hsk.blockscout.com",
  133: "https://testnet-explorer.hskchain.net",
};

export function rpcUrlFor(chainId: number, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`COUNTERSIGN_RPC_${chainId}`] || KNOWN_RPC[chainId];
}

export function explorerUrl(chainId: number, kind: "tx" | "address", value: string): string | undefined {
  const base = KNOWN_EXPLORER[chainId];
  return base ? `${base}/${kind}/${value}` : undefined;
}
