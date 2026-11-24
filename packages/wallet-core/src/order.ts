import { RawOrderSchema, canonicalize } from "@ouryn/hsp";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { parseUint, uintToString } from "./amount.js";

/** HSP `get_order`로 다시 가져온 주문을 지갑 내부 형태로 바꾼 것. 금액은 bigint 최소 단위. */
export interface Order {
  orderRef: string;
  payTo: Address;
  amount: bigint;
  chainId: number;
  token: Address;
  /** unix seconds */
  expiresAt: number;
}

/** HSP 응답(검증 안 된 값) → Order. zod 검증 후 주소는 체크섬 형태로 통일한다. */
export function normalizeOrder(raw: unknown): Order {
  const r = RawOrderSchema.parse(raw);
  return {
    orderRef: r.order_ref,
    payTo: getAddress(r.pay_to),
    amount: parseUint(r.amount),
    chainId: r.chain_id,
    token: getAddress(r.token),
    expiresAt: r.expires_at,
  };
}

/** 해시·티켓용 직렬화 형태 (bigint → 문자열) */
export function orderToJson(o: Order) {
  return {
    orderRef: o.orderRef,
    payTo: o.payTo,
    amount: uintToString(o.amount),
    chainId: o.chainId,
    token: o.token,
    expiresAt: o.expiresAt,
  };
}

export function orderFromJson(j: {
  orderRef: string;
  payTo: string;
  amount: string;
  chainId: number;
  token: string;
  expiresAt: number;
}): Order {
  return {
    orderRef: j.orderRef,
    payTo: getAddress(j.payTo),
    amount: parseUint(j.amount),
    chainId: j.chainId,
    token: getAddress(j.token),
    expiresAt: j.expiresAt,
  };
}

export function orderHash(o: Order): Hex {
  return keccak256(stringToHex(canonicalize(orderToJson(o))));
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
