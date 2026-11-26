import {
  MemorySpendLedger,
  TWA_FIELDS,
  TWA_PRIMARY_TYPE,
  checkSignature,
  reject,
  verifyPayment,
  verifyTicket,
  type PauseState,
  type CheckExtras,
  type PolicyInput,
  resolvePolicy,
  type Rejection,
  type SpendLedger,
} from "@countersign/wallet-core";
import type { Address, Hex, LocalAccount } from "viem";
import { z } from "zod";

/**
 * 서명 프로세스의 핵심 (PROJECT.md §5, 차별점 D3).
 * - 키(LocalAccount)는 이 객체 안에만 있다. 밖으로 꺼내는 함수가 없다.
 * - 하는 일은 세 가지뿐: 주소 알려 주기, 검증 티켓이 붙은 결제 서명, 주인 계정으로 출금(받는 곳 고정).
 * - 임의 메시지 서명·키 내보내기·정책 변경 요청은 존재하지 않는다 (AGENTS.md 규칙 4, 6).
 * - 티켓을 믿지 않는다: 자기 정책 사본과 자기 지출 기록으로 같은 검증을 처음부터 다시 한다.
 * - 에이전트마다 계정이 다르다 (니모닉 다음 번호). 요청의 agent로 계정·정책·지출 기록을 고른다.
 */
const agentField = z.string().regex(/^[a-z0-9_]{1,64}$/).optional();
export const SignerRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("address"), agent: agentField }).strict(),
  z.object({ op: z.literal("sign_payment"), agent: agentField, ticket: z.unknown(), typedData: z.unknown() }).strict(),
  z
    .object({
      op: z.literal("withdraw_to_owner"),
      agent: agentField,
      /** 최소 단위 정수 문자열. 없으면 전액 */
      amount: z.string().regex(/^\d{1,30}$/).optional(),
      /** 주인 API 토큰 (signer가 같은 파일을 읽어 대조) */
      ownerToken: z.string().min(1).max(200),
      /** 같은 출금 요청을 두 번 보내도 한 번만 나가게 하는 id (주인 API가 만든다) */
      requestId: z.string().regex(/^[a-z0-9_-]{8,64}$/).optional(),
    })
    .strict(),
]);
export type SignerRequest = z.infer<typeof SignerRequestSchema>;

export interface WithdrawResult {
  ok: true;
  op: "withdraw_to_owner";
  /** done: 영수증 확인 / pending: 보냈는데 아직 영수증 전 (같은 requestId로 다시 물으면 이어서 확인) */
  status: "done" | "pending";
  request_id: string;
  tx_hash: Hex;
  from: Address;
  to: Address;
  amount: string;
  chain_id: number;
  token: Address;
}

export type SignerResponse =
  | { ok: true; op: "address"; address: Address; account_index: number }
  | { ok: true; op: "sign_payment"; signature: Hex; typedDataHash: Hex }
  | WithdrawResult
  | Rejection;

/** 에이전트 하나의 서명 재료 */
export interface SignerAgent {
  account: LocalAccount;
  accountIndex: number;
  /** 함수로 주면 서명할 때마다 다시 읽는다 */
  policy: PolicyInput;
  ledger: SpendLedger;
  /** 끊겼거나 멈춘 에이전트면 거절 사유 (서명할 때마다 다시 묻는다) */
  blocked?: () => "disconnected" | "paused" | undefined;
}

export interface SignerDeps {
  /** 기본 에이전트 (agent 없이 온 요청, stdio 로컬 = 1번 계정) */
  account: LocalAccount;
  policy: PolicyInput;
  ledger?: SpendLedger;
  /** agent id → 그 에이전트. 모르는 id면 undefined → 거절 */
  agents?: (agentId: string) => SignerAgent | undefined;
  ticketSecret: Buffer;
  now?: () => number;
  /** 주인의 전체 정지 스위치. 서명할 때마다 다시 읽는다 (지갑 MCP가 뚫려도 signer가 멈춘다) */
  pause?: () => PauseState;
  /** 주인 결정(구매 승인, 맡긴 일 상한)을 상태 파일에서 읽는다. 티켓에 실린 값은 쓰지 않는다 */
  extras?: (orderRef: string, intent: unknown, agentId: string) => CheckExtras;
  /** 출금: 주인 토큰 확인 + 체인 거래. 없으면 출금 요청을 거절 */
  withdraw?: {
    checkOwnerToken: (token: string) => boolean;
    run: (agent: SignerAgent, amount: bigint | undefined, requestId: string, agentId: string) => Promise<WithdrawResult | Rejection>;
  };
}

export interface Signer {
  readonly address: Address;
  handle(request: unknown): Promise<SignerResponse>;
}

const MAX_USED_TICKETS = 10_000;

export function createSigner(deps: SignerDeps): Signer {
  const { ticketSecret } = deps;
  const defaultAgent: SignerAgent = {
    account: deps.account,
    accountIndex: resolvePolicy(deps.policy).accountIndex,
    policy: deps.policy,
    ledger: deps.ledger ?? new MemorySpendLedger(),
  };
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const usedTickets = new Set<string>();
  let busy: Promise<unknown> = Promise.resolve();

  function agentFor(id: string | undefined): SignerAgent | Rejection {
    if (!id || id === "local") return defaultAgent;
    const a = deps.agents?.(id);
    if (!a) return reject("INVALID_INPUT", "input", "모르는 에이전트");
    return a;
  }

  async function signPayment(agentId: string | undefined, ticketInput: unknown, typedData: unknown): Promise<SignerResponse> {
    const t = now();
    const pause = deps.pause?.();
    if (pause?.paused) return reject("WALLET_PAUSED", "pause", "주인이 결제를 정지함");
    const agent = agentFor(agentId);
    if ("ok" in agent) return agent;
    const blocked = agent.blocked?.();
    if (blocked === "disconnected") return reject("INVALID_INPUT", "input", "연결이 끊긴 에이전트");
    if (blocked === "paused") return reject("WALLET_PAUSED", "pause", "주인이 이 에이전트를 멈춤");
    let policy;
    try {
      policy = resolvePolicy(agent.policy);
    } catch {
      return reject("POLICY_INVALID", "policy", "정책 파일을 읽을 수 없음");
    }
    if (policy.accountIndex !== agent.accountIndex) {
      return reject("POLICY_INVALID", "policy", "정책의 accountIndex가 이 에이전트 계정과 다름");
    }
    const ticket = verifyTicket(ticketSecret, ticketInput, t);
    if (!ticket.ok) return reject("TICKET_INVALID", "ticket", ticket.reason);
    if ((ticket.agent ?? "local") !== (agentId ?? "local")) {
      return reject("TICKET_INVALID", "ticket", "다른 에이전트에게 발급된 티켓");
    }
    if (usedTickets.has(ticket.id)) return reject("TICKET_INVALID", "ticket", "이미 쓴 티켓");
    if (usedTickets.size >= MAX_USED_TICKETS) usedTickets.clear(); // 티켓 수명(60초)보다 훨씬 긴 기록이라 안전
    usedTickets.add(ticket.id);

    const v = verifyPayment({
      order: ticket.order,
      intent: ticket.intent,
      policy,
      ledger: agent.ledger,
      typedData,
      agent: agent.account.address,
      now: t,
      ...(deps.extras && { extras: deps.extras(ticket.order.orderRef, ticket.intent, agentId ?? "local") }),
    });
    if (!v.ok) return v;
    if (v.typedDataHash.toLowerCase() !== ticket.typedDataHash) {
      return reject("TICKET_INVALID", "ticket", "티켓의 typed data 해시가 요청과 다름");
    }

    const signature = await agent.account.signTypedData({
      domain: v.td.domain,
      types: { [TWA_PRIMARY_TYPE]: TWA_FIELDS },
      primaryType: TWA_PRIMARY_TYPE,
      message: v.td.message,
    });
    const self = await checkSignature(v.td, signature, agent.account.address);
    if (!self.ok) return self;
    agent.ledger.record(ticket.order.orderRef, ticket.order.amount, t);
    return { ok: true, op: "sign_payment", signature, typedDataHash: v.typedDataHash };
  }

  async function withdraw(
    agentId: string | undefined,
    amount: string | undefined,
    ownerToken: string,
    requestId: string | undefined,
  ): Promise<SignerResponse> {
    if (!deps.withdraw) return reject("INVALID_INPUT", "input", "이 signer는 출금을 지원하지 않음");
    if (!deps.withdraw.checkOwnerToken(ownerToken)) return reject("INVALID_INPUT", "input", "주인 토큰이 맞지 않음");
    const agent = agentFor(agentId);
    if ("ok" in agent) return agent;
    // 출금은 한도·정지와 상관없이 허용한다: 받는 곳이 주인 계정으로 고정이라 "안전한 방향"
    return deps.withdraw.run(
      agent,
      amount === undefined ? undefined : BigInt(amount),
      requestId ?? `wd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      agentId ?? "local",
    );
  }

  /** 서명·출금은 한 번에 하나씩 (일일 한도 검사와 기록 사이에 다른 요청이 끼지 않게) */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = busy.then(fn);
    busy = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    address: deps.account.address,
    async handle(request: unknown): Promise<SignerResponse> {
      const p = SignerRequestSchema.safeParse(request);
      if (!p.success) return reject("INVALID_INPUT", "input", "지원하지 않는 요청");
      const req = p.data;
      if (req.op === "address") {
        const a = agentFor(req.agent);
        if ("ok" in a) return a;
        return { ok: true, op: "address", address: a.account.address, account_index: a.accountIndex };
      }
      if (req.op === "sign_payment") return serial(() => signPayment(req.agent, req.ticket, req.typedData));
      // 출금은 결제 서명 줄과 따로 (영수증을 기다리는 동안 결제를 막지 않게). 같은 에이전트 동시 출금은 withdraw.run이 막는다
      return withdraw(req.agent, req.amount, req.ownerToken, req.requestId);
    },
  };
}
