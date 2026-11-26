import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpcUrlFor } from "@countersign/hsp";
import { TWA_FIELDS, TWA_PRIMARY_TYPE, reject, resolvePolicy, type Rejection } from "@countersign/wallet-core";
import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, parseSignature, type Address, type Hex, type LocalAccount } from "viem";
import { z } from "zod";
import type { SignerAgent, WithdrawResult } from "./signer.js";

/**
 * 출금: 에이전트 계정의 USDC를 주인 0번 계정으로 돌려받는다. 결제가 아니므로 HSP를 거치지 않는다.
 * - 받는 곳은 주인 0번 계정으로 고정이다. 요청으로 받는 곳을 바꿀 수 없다.
 * - 에이전트 키로 EIP-3009 TransferWithAuthorization(→ 주인)에 서명하고, 주인 계정이 그 서명을 USDC 컨트랙트에 내며 가스를 낸다.
 *   그래서 에이전트 계정에 가스(ETH)가 없어도 된다.
 * - 토큰·체인은 그 에이전트 정책의 첫 체인 USDC다.
 *
 * 중복 방지 (11/27 리뷰 P2-6): 요청 id마다 기록 파일을 먼저 쓰고, 거래를 보내자마자 tx 해시를 적는다.
 * - 같은 id로 다시 오면 새로 보내지 않고 그 거래의 결과만 확인한다 (응답이 끊겨 주인 앱이 다시 눌러도 한 번만 나간다).
 * - 같은 에이전트에 아직 영수증 전인 출금이 있으면 새 출금을 거절한다.
 * - 영수증은 최대 90초 기다리고, 그 안에 안 오면 status "pending"과 tx 해시를 돌려준다.
 */
const FIAT_TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
]);

const RecordSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  /** sending: 서명·전송 중(해시 전) / sent: 전송됨(영수증 전) / done / failed */
  status: z.enum(["sending", "sent", "done", "failed"]),
  at: z.number(),
  chain_id: z.number().optional(),
  token: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  amount: z.string().optional(),
  tx_hash: z.string().optional(),
  reason: z.string().optional(),
});
type Rec = z.infer<typeof RecordSchema>;

class WithdrawLog {
  constructor(private readonly dir: string) {}
  get(id: string): Rec | undefined {
    const p = join(this.dir, `${id}.json`);
    if (!existsSync(p)) return undefined;
    try {
      return RecordSchema.parse(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      return undefined;
    }
  }
  put(r: Rec): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = join(this.dir, `${r.id}.json`);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
    renameSync(tmp, p);
    chmodSync(p, 0o600);
  }
  /** 이 에이전트의 아직 안 끝난 출금 (10분 넘은 sending은 서명 전에 죽은 것으로 보고 무시) */
  inflight(agentId: string, now: number): Rec | undefined {
    if (!existsSync(this.dir)) return undefined;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const r = this.get(f.slice(0, -5));
      if (!r || r.agent_id !== agentId) continue;
      if (r.status === "sent" || (r.status === "sending" && now - r.at < 600)) return r;
    }
    return undefined;
  }
}

export function makeWithdraw(owner: LocalAccount, opts: { dir: string; env?: NodeJS.ProcessEnv; receiptTimeoutMs?: number }) {
  const env = opts.env ?? process.env;
  const log = new WithdrawLog(opts.dir);
  const receiptTimeout = opts.receiptTimeoutMs ?? 90_000;
  const locks = new Set<string>();

  return async (agent: SignerAgent, amount: bigint | undefined, requestId: string, agentId: string): Promise<WithdrawResult | Rejection> => {
    const fail = (why: string) => reject("WITHDRAW_FAILED", "withdraw", why);
    const now = () => Math.floor(Date.now() / 1000);
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

    const result = (r: Rec, status: "done" | "pending"): WithdrawResult => ({
      ok: true,
      op: "withdraw_to_owner",
      status,
      request_id: r.id,
      tx_hash: r.tx_hash as Hex,
      from: r.from as Address,
      to: r.to as Address,
      amount: r.amount!,
      chain_id: r.chain_id!,
      token: r.token as Address,
    });
    const waitReceipt = async (r: Rec): Promise<WithdrawResult | Rejection> => {
      try {
        const receipt = await pub.waitForTransactionReceipt({ hash: r.tx_hash as Hex, timeout: receiptTimeout });
        if (receipt.status !== "success") {
          log.put({ ...r, status: "failed", reason: "거래가 체인에서 실패함" });
          return fail(`거래가 실패함 (${r.tx_hash})`);
        }
        log.put({ ...r, status: "done" });
        return result(r, "done");
      } catch {
        // 영수증을 아직 못 받음: 보낸 거래는 그대로 두고, 같은 요청 id로 다시 물으면 이어서 확인한다
        return result(r, "pending");
      }
    };

    // 같은 요청을 다시 받음: 새로 보내지 않는다
    const prev = log.get(requestId);
    if (prev) {
      if (prev.agent_id !== agentId) return fail("다른 에이전트의 출금 요청 id");
      if (prev.status === "done") return result(prev, "done");
      if (prev.status === "sent") return waitReceipt(prev);
      if (prev.status === "failed") return fail(prev.reason ?? "이전 출금이 실패함");
      return fail("이 출금은 아직 처리 중 (잠시 뒤 같은 요청으로 다시 확인)");
    }
    if (locks.has(agentId) || log.inflight(agentId, now())) {
      return fail("이 에이전트의 이전 출금이 아직 끝나지 않음 (영수증 확인 후 다시 시도)");
    }
    locks.add(agentId);
    const rec: Rec = { id: requestId, agent_id: agentId, status: "sending", at: now(), chain_id: chainId, token, from: agent.account.address, to: owner.address };
    log.put(rec);
    try {
      if ((await pub.getChainId()) !== chainId) {
        log.put({ ...rec, status: "failed", reason: "RPC 체인이 정책과 다름" });
        return fail("RPC 체인이 정책과 다름");
      }
      const balance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [agent.account.address] });
      const value = amount ?? balance;
      const bad = value === 0n ? "출금할 USDC가 없음" : value > balance ? "잔액보다 많이 출금할 수 없음" : undefined;
      if (bad) {
        log.put({ ...rec, status: "failed", reason: bad });
        return fail(bad);
      }
      const [name, version] = await Promise.all([
        pub.readContract({ address: token, abi: FIAT_TOKEN_ABI, functionName: "name" }),
        pub.readContract({ address: token, abi: FIAT_TOKEN_ABI, functionName: "version" }),
      ]);
      const message = {
        from: agent.account.address,
        to: owner.address,
        value,
        validAfter: 0n,
        validBefore: BigInt(now() + 600),
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
      // 보내자마자 해시를 적는다 (응답이 끊겨도 같은 요청으로 이어서 확인)
      const sent: Rec = { ...rec, status: "sent", amount: value.toString(), tx_hash: hash };
      log.put(sent);
      return await waitReceipt(sent);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : "알 수 없는 오류";
      const why = /insufficient funds/i.test(msg) ? "주인 0번 계정에 가스(ETH)가 부족함" : `출금 실패: ${msg}`;
      const cur = log.get(requestId);
      // 해시를 받기 전 실패만 failed로 적는다 (보낸 뒤라면 sent 상태를 남겨 둔다)
      if (cur?.status === "sending") log.put({ ...cur, status: "failed", reason: why });
      return fail(why);
    } finally {
      locks.delete(agentId);
    }
  };
}
