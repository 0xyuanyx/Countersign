import { RawTypedDataSchema } from "@countersign/hsp";
import {
  getAddress,
  getTypesForEIP712Domain,
  hashTypedData,
  isAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { parseUint } from "./amount.js";
import { orderHash, sameAddress, type Order } from "./order.js";
import { checkOrder, type Intent, type Policy, type SpendLedger } from "./policy.js";
import { reject, type Rejection } from "./rejection.js";

/**
 * Evidence 검증기 (Ouryn `EVMEvidence.parse/matches`의 TS 재구축).
 * HSP `prepare_payment`가 돌려준 EIP-712 서명 대상을 직접 디코드해서,
 * get_order로 다시 가져온 주문·정책과 필드별로 대조한다. 하나라도 다르면 서명하지 않는다.
 *
 * 지원하는 서명 형식은 EIP-3009 TransferWithAuthorization 하나뿐이다 (HSK USDC 방식, §4.3).
 * 다른 primaryType(예: Permit, 임의 메시지)은 모두 거부한다.
 */
export const TWA_PRIMARY_TYPE = "TransferWithAuthorization";
export const TWA_FIELDS = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export interface TwaTypedData {
  domain: { name?: string; version?: string; chainId: number; verifyingContract: Address; salt?: Hex };
  primaryType: typeof TWA_PRIMARY_TYPE;
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
}

const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;

/** 검증 안 된 typed data → TwaTypedData. 형식이 하나라도 어긋나면 TYPED_DATA_MISMATCH. */
export function parseTypedData(raw: unknown): { ok: true; td: TwaTypedData } | Rejection {
  const step = "typed_data";
  const r = RawTypedDataSchema.safeParse(raw);
  if (!r.success) return reject("TYPED_DATA_MISMATCH", step, "typed data 형식이 아님");
  const t = r.data;

  if (t.primaryType !== TWA_PRIMARY_TYPE) {
    return reject("TYPED_DATA_MISMATCH", step, `지원하지 않는 서명 형식 ${t.primaryType.slice(0, 64)}`);
  }
  // types: TWA 정의가 정확히 같아야 하고, 다른 타입이 섞이면 안 된다 (타입 혼동 방지)
  const typeKeys = Object.keys(t.types).filter((k) => k !== "EIP712Domain");
  if (typeKeys.length !== 1 || typeKeys[0] !== TWA_PRIMARY_TYPE) {
    return reject("TYPED_DATA_MISMATCH", step, "types에 TransferWithAuthorization 외의 타입이 있음");
  }
  if (!sameFields(t.types[TWA_PRIMARY_TYPE], TWA_FIELDS)) {
    return reject("TYPED_DATA_MISMATCH", step, "TransferWithAuthorization 필드 정의가 표준과 다름");
  }

  let chainId: number;
  try {
    const c = parseUint(t.domain.chainId);
    if (c > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
    chainId = Number(c);
  } catch {
    return reject("TYPED_DATA_MISMATCH", step, "domain.chainId 형식이 아님");
  }
  const domain: TwaTypedData["domain"] = {
    ...(t.domain.name !== undefined && { name: t.domain.name }),
    ...(t.domain.version !== undefined && { version: t.domain.version }),
    chainId,
    verifyingContract: getAddress(t.domain.verifyingContract),
    ...(t.domain.salt !== undefined && { salt: t.domain.salt as Hex }),
  };
  // EIP712Domain을 같이 보냈다면 domain 객체와 정확히 맞아야 한다 (viem은 domain에서 다시 만든다)
  if (t.types.EIP712Domain && !sameFields(t.types.EIP712Domain, getTypesForEIP712Domain({ domain }))) {
    return reject("TYPED_DATA_MISMATCH", step, "EIP712Domain 정의가 domain과 다름");
  }

  const m = t.message;
  const keys = Object.keys(m).sort();
  const expectedKeys = TWA_FIELDS.map((f) => f.name).sort();
  if (keys.join(",") !== expectedKeys.join(",")) {
    return reject("TYPED_DATA_MISMATCH", step, "message 필드가 표준과 다름");
  }
  if (typeof m.from !== "string" || !isAddress(m.from, { strict: false })) {
    return reject("TYPED_DATA_MISMATCH", step, "message.from 주소 형식이 아님");
  }
  if (typeof m.to !== "string" || !isAddress(m.to, { strict: false })) {
    return reject("TYPED_DATA_MISMATCH", step, "message.to 주소 형식이 아님");
  }
  if (typeof m.nonce !== "string" || !NONCE_RE.test(m.nonce)) {
    return reject("TYPED_DATA_MISMATCH", step, "message.nonce가 bytes32가 아님");
  }
  try {
    return {
      ok: true,
      td: {
        domain,
        primaryType: TWA_PRIMARY_TYPE,
        message: {
          from: getAddress(m.from),
          to: getAddress(m.to),
          value: parseUint(m.value),
          validAfter: parseUint(m.validAfter),
          validBefore: parseUint(m.validBefore),
          nonce: m.nonce as Hex,
        },
      },
    };
  } catch {
    return reject("TYPED_DATA_MISMATCH", step, "message uint 필드 형식이 아님");
  }
}

function sameFields(
  a: readonly { name: string; type: string }[] | undefined,
  b: readonly { name: string; type: string }[],
): boolean {
  return !!a && a.length === b.length && a.every((f, i) => f.name === b[i]!.name && f.type === b[i]!.type);
}

export interface TypedDataContext {
  /** 이 정책의 에이전트 계정 주소 (서명자) */
  agent: Address;
  now: number;
  maxAuthorizationSeconds: number;
}

/** 서명 대상을 주문과 필드별 대조 (§5.1 5단계). */
export function checkTypedData(td: TwaTypedData, order: Order, ctx: TypedDataContext): { ok: true } | Rejection {
  const step = "typed_data";
  const m = td.message;
  const bad = (what: string) => reject("TYPED_DATA_MISMATCH", step, what);
  if (td.domain.chainId !== order.chainId) return bad(`chainId ${td.domain.chainId} ≠ 주문 ${order.chainId}`);
  if (!sameAddress(td.domain.verifyingContract, order.token)) return bad("verifyingContract가 주문 토큰과 다름");
  if (!sameAddress(m.from, ctx.agent)) return bad("from이 이 에이전트 계정이 아님");
  if (!sameAddress(m.to, order.payTo)) return bad("to가 주문의 pay_to와 다름");
  if (m.value !== order.amount) return bad("value가 주문 금액과 다름");
  const now = BigInt(ctx.now);
  if (m.validAfter > now) return bad("validAfter가 미래");
  if (m.validBefore <= now) return reject("EXPIRED", step, "서명 유효 기간(validBefore)이 이미 지남");
  if (m.validBefore > now + BigInt(ctx.maxAuthorizationSeconds)) {
    return bad(`validBefore가 너무 멂 (최대 ${ctx.maxAuthorizationSeconds}초)`);
  }
  return { ok: true };
}

export function typedDataHash(td: TwaTypedData): Hex {
  return hashTypedData({
    domain: td.domain,
    types: { [TWA_PRIMARY_TYPE]: TWA_FIELDS },
    primaryType: TWA_PRIMARY_TYPE,
    message: td.message,
  });
}

/** 서명 후 서명자 복원 (§5.1 6단계) */
export async function checkSignature(td: TwaTypedData, signature: Hex, expected: Address): Promise<{ ok: true } | Rejection> {
  try {
    const recovered = await recoverTypedDataAddress({
      domain: td.domain,
      types: { [TWA_PRIMARY_TYPE]: TWA_FIELDS },
      primaryType: TWA_PRIMARY_TYPE,
      message: td.message,
      signature,
    });
    if (sameAddress(recovered, expected) && sameAddress(recovered, td.message.from)) return { ok: true };
    return reject("SIGNATURE_INVALID", "signature", "서명자가 에이전트 계정이 아님");
  } catch {
    return reject("SIGNATURE_INVALID", "signature", "서명을 복원할 수 없음");
  }
}

export interface PaymentCheckInput {
  order: Order;
  intent: unknown;
  policy: Policy;
  ledger: SpendLedger;
  typedData: unknown;
  agent: Address;
  now: number;
}

export interface VerifiedPayment {
  ok: true;
  intent: Intent;
  td: TwaTypedData;
  typedDataHash: Hex;
  orderHash: Hex;
}

/** 정책 검사 + typed data 대조를 한 번에. 지갑 MCP와 signer가 같은 함수를 쓴다. */
export function verifyPayment(input: PaymentCheckInput): VerifiedPayment | Rejection {
  const p = checkOrder(input.order, input.intent, input.policy, input.ledger, input.now);
  if (!p.ok) return p;
  const parsed = parseTypedData(input.typedData);
  if (!parsed.ok) return parsed;
  const c = checkTypedData(parsed.td, input.order, {
    agent: input.agent,
    now: input.now,
    maxAuthorizationSeconds: input.policy.maxAuthorizationSeconds,
  });
  if (!c.ok) return c;
  return {
    ok: true,
    intent: p.intent,
    td: parsed.td,
    typedDataHash: typedDataHash(parsed.td),
    orderHash: orderHash(input.order),
  };
}

/** EvidenceRegistry.record 인자 (§6) */
export interface EvidenceRecord {
  orderHash: Hex;
  typedDataHash: Hex;
  payTo: Address;
  amount: bigint;
  payChainId: number;
  payTxHash: Hex;
}

export function buildEvidence(v: VerifiedPayment, order: Order, payTxHash: Hex): EvidenceRecord {
  return {
    orderHash: v.orderHash,
    typedDataHash: v.typedDataHash,
    payTo: order.payTo,
    amount: order.amount,
    payChainId: order.chainId,
    payTxHash,
  };
}
