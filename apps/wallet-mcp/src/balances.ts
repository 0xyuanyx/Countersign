import { rpcUrlFor } from "@countersign/hsp";
import { createPublicClient, erc20Abi, http, type Address } from "viem";
import type { BalanceReader } from "./service.js";

/** 공개 RPC로 잔액을 읽기만 한다 (주소 표는 @countersign/hsp KNOWN_RPC, 다른 체인은 COUNTERSIGN_RPC_<chainId>) */
export function rpcBalanceReader(env: NodeJS.ProcessEnv = process.env): BalanceReader & {
  nativeBalance(chainId: number, owner: Address): Promise<bigint>;
} {
  const client = (chainId: number) => {
    const url = rpcUrlFor(chainId, env);
    if (!url) throw new Error(`체인 ${chainId} RPC 주소 없음`);
    return createPublicClient({ transport: http(url, { timeout: 10_000 }) });
  };
  return {
    async usdcBalance(chainId: number, token: Address, owner: Address): Promise<bigint> {
      return client(chainId).readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    },
    async nativeBalance(chainId: number, owner: Address): Promise<bigint> {
      return client(chainId).getBalance({ address: owner });
    },
  };
}
