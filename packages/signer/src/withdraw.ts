import { randomBytes } from "node:crypto";
import { rpcUrlFor } from "@countersign/hsp";
import { TWA_FIELDS, TWA_PRIMARY_TYPE, reject, resolvePolicy, type Rejection } from "@countersign/wallet-core";
import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, parseSignature, type Address, type Hex, type LocalAccount } from "viem";
import type { SignerAgent, WithdrawResult } from "./signer.js";

/**
 * 출금: 에이전트 계정의 USDC를 주인 0번 계정으로 돌려받는다. 결제가 아니므로 HSP를 거치지 않는다.
 * - 받는 곳은 주인 0번 계정으로 고정이다. 요청으로 받는 곳을 바꿀 수 없다.
 * - 에이전트 키로 EIP-3009 TransferWithAuthorization(→ 주인)에 서명하고, 주인 계정이 그 서명을 USDC 컨트랙트에 내며 가스를 낸다.
 *   그래서 에이전트 계정에 가스(ETH)가 없어도 된다.
 * - 토큰·체인은 그 에이전트 정책의 첫 체인 USDC다.
 */
const FIAT_TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
]);

export function makeWithdraw(owner: LocalAccount, env: NodeJS.ProcessEnv = process.env) {
  return async (agent: SignerAgent, amount: bigint | undefined): Promise<WithdrawResult | Rejection> => {
    const fail = (why: string) => reject("WITHDRAW_FAILED", "withdraw", why);
    let policy;
    try {
      policy = resolvePolicy(agent.policy);
    } catch {
      return reject("POLICY_INVALID", "policy", "정책 파일을 읽을 수 없음");
    }
    const chainId = [...policy.chains][0]!;
    const token = policy.tokens.get(chainId)!;
    const url = rpcUrlFor(chainId, env);
    if (!url) return fail(`체인 ${chainId} RPC 주소 없음`);
    const pub = createPublicClient({ transport: http(url, { timeout: 15_000 }) });
    try {
      if ((await pub.getChainId()) !== chainId) return fail("RPC 체인이 정책과 다름");
      const balance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [agent.account.address] });
      const value = amount ?? balance;
      if (value === 0n) return fail("출금할 USDC가 없음");
      if (value > balance) return fail("잔액보다 많이 출금할 수 없음");
      const [name, version] = await Promise.all([
        pub.readContract({ address: token, abi: FIAT_TOKEN_ABI, functionName: "name" }),
        pub.readContract({ address: token, abi: FIAT_TOKEN_ABI, functionName: "version" }),
      ]);
      const message = {
        from: agent.account.address,
        to: owner.address,
        value,
        validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
        nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
      };
      const sig = await agent.account.signTypedData({
        domain: { name, version, chainId, verifyingContract: token },
        types: { [TWA_PRIMARY_TYPE]: TWA_FIELDS },
        primaryType: TWA_PRIMARY_TYPE,
        message,
      });
      const { r, s, v, yParity } = parseSignature(sig);
      const wallet = createWalletClient({ account: owner, transport: http(url, { timeout: 15_000 }) });
      const hash = await wallet.writeContract({
        chain: null,
        address: token,
        abi: FIAT_TOKEN_ABI,
        functionName: "transferWithAuthorization",
        args: [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, Number(v ?? BigInt(27 + (yParity ?? 0))), r, s],
      });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") return fail(`거래가 실패함 (${hash})`);
      return {
        ok: true,
        op: "withdraw_to_owner",
        tx_hash: hash,
        from: agent.account.address,
        to: owner.address as Address,
        amount: value.toString(),
        chain_id: chainId,
        token,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : "알 수 없는 오류";
      return fail(/insufficient funds/i.test(msg) ? "주인 0번 계정에 가스(ETH)가 부족함" : `출금 실패: ${msg}`);
    }
  };
}
