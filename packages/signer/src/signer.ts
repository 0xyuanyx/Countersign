import {
  MemorySpendLedger,
  TWA_FIELDS,
  TWA_PRIMARY_TYPE,
  checkSignature,
  reject,
  verifyPayment,
  verifyTicket,
  type PauseState,
  type Policy,
  type Rejection,
  type SpendLedger,
} from "@countersign/wallet-core";
import type { Address, Hex, LocalAccount } from "viem";
import { z } from "zod";

/**
 * 서명 프로세스의 핵심 (PROJECT.md §5, 차별점 D3).
 * - 키(LocalAccount)는 이 객체 안에만 있다. 밖으로 꺼내는 함수가 없다.
 * - 하는 일은 두 가지뿐: 주소 알려 주기, 검증 티켓이 붙은 결제 서명.
 * - 임의 메시지 서명·키 내보내기·정책 변경 요청은 존재하지 않는다 (AGENTS.md 규칙 4, 6).
 * - 티켓을 믿지 않는다: 자기 정책 사본과 자기 지출 기록으로 같은 검증을 처음부터 다시 한다.
 */
export const SignerRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("address") }).strict(),
  z.object({ op: z.literal("sign_payment"), ticket: z.unknown(), typedData: z.unknown() }).strict(),
]);
export type SignerRequest = z.infer<typeof SignerRequestSchema>;

export type SignerResponse =
  | { ok: true; op: "address"; address: Address }
  | { ok: true; op: "sign_payment"; signature: Hex; typedDataHash: Hex }
  | Rejection;

export interface SignerDeps {
  account: LocalAccount;
  policy: Policy;
  ticketSecret: Buffer;
  ledger?: SpendLedger;
  now?: () => number;
  /** 주인의 정지 스위치. 서명할 때마다 다시 읽는다 (지갑 MCP가 뚫려도 signer가 멈춘다) */
  pause?: () => PauseState;
}

export interface Signer {
  readonly address: Address;
  handle(request: unknown): Promise<SignerResponse>;
}

const MAX_USED_TICKETS = 10_000;

export function createSigner(deps: SignerDeps): Signer {
  const { account, policy, ticketSecret } = deps;
  const ledger = deps.ledger ?? new MemorySpendLedger();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const usedTickets = new Set<string>();
  let busy = Promise.resolve();

  async function signPayment(ticketInput: unknown, typedData: unknown): Promise<SignerResponse> {
    const t = now();
    const pause = deps.pause?.();
    if (pause?.paused) return reject("PAUSED", "pause", "주인이 결제를 정지함");
    const ticket = verifyTicket(ticketSecret, ticketInput, t);
    if (!ticket.ok) return reject("TICKET_INVALID", "ticket", ticket.reason);
    if (usedTickets.has(ticket.id)) return reject("TICKET_INVALID", "ticket", "이미 쓴 티켓");
    if (usedTickets.size >= MAX_USED_TICKETS) usedTickets.clear(); // 티켓 수명(60초)보다 훨씬 긴 기록이라 안전
    usedTickets.add(ticket.id);

    const v = verifyPayment({
      order: ticket.order,
      intent: ticket.intent,
      policy,
      ledger,
      typedData,
      agent: account.address,
      now: t,
    });
    if (!v.ok) return v;
    if (v.typedDataHash.toLowerCase() !== ticket.typedDataHash) {
      return reject("TICKET_INVALID", "ticket", "티켓의 typed data 해시가 요청과 다름");
    }

    const signature = await account.signTypedData({
      domain: v.td.domain,
      types: { [TWA_PRIMARY_TYPE]: TWA_FIELDS },
      primaryType: TWA_PRIMARY_TYPE,
      message: v.td.message,
    });
    const self = await checkSignature(v.td, signature, account.address);
    if (!self.ok) return self;
    ledger.record(ticket.order.orderRef, ticket.order.amount, t);
    return { ok: true, op: "sign_payment", signature, typedDataHash: v.typedDataHash };
  }

  return {
    address: account.address,
    async handle(request: unknown): Promise<SignerResponse> {
      const p = SignerRequestSchema.safeParse(request);
      if (!p.success) return reject("INVALID_INPUT", "input", "지원하지 않는 요청");
      if (p.data.op === "address") return { ok: true, op: "address", address: account.address };
      const { ticket, typedData } = p.data;
      // 서명 요청은 한 번에 하나씩 (일일 한도 검사와 기록 사이에 다른 요청이 끼지 않게)
      const run = busy.then(() => signPayment(ticket, typedData));
      busy = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
