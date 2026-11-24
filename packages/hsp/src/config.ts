import { z } from "zod";

/**
 * 결제 체인과 HSP 주소는 운영진 답(§9 #1·#2)이 오기 전까지 설정값으로 둔다.
 * 코드 어디에도 "결제는 이 체인" 같은 상수를 박지 않는다.
 */
export const HspConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("mock"),
    payChainId: z.number().int().positive().default(133),
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
  const mode = env.OURYN_HSP_MODE ?? "mock";
  const payChainId = env.OURYN_PAY_CHAIN_ID ? Number(env.OURYN_PAY_CHAIN_ID) : undefined;
  return HspConfigSchema.parse({ mode, mcpUrl: env.OURYN_HSP_MCP_URL || undefined, payChainId });
}

/** 공개 토큰 주소 (PROJECT.md §4.3). 다른 체인은 정책 파일 tokenAddresses로 넣는다. */
export const KNOWN_USDC: Readonly<Record<number, `0x${string}`>> = {
  177: "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
  133: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6",
};
