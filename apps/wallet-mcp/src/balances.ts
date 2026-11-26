import { createPublicClient, erc20Abi, http, type Address } from "viem";
import type { BalanceReader } from "./service.js";

/** 공개 RPC (PROJECT.md §4.3). 다른 체인은 COUNTERSIGN_RPC_<chainId> 환경변수로. 읽기만 한다. */
const KNOWN_RPC: Record<number, string> = {
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  177: "https://mainnet.hsk.xyz",
  133: "https://testnet.hsk.xyz",
};

export function rpcBalanceReader(env: NodeJS.ProcessEnv = process.env): BalanceReader {
  return {
    async usdcBalance(chainId: number, token: Address, owner: Address): Promise<bigint> {
      const url = env[`COUNTERSIGN_RPC_${chainId}`] || KNOWN_RPC[chainId];
      if (!url) throw new Error(`체인 ${chainId} RPC 주소 없음`);
      const client = createPublicClient({ transport: http(url, { timeout: 10_000 }) });
      return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    },
  };
}
