/**
 * 에이전트가 읽을 수 있는 거부 (PROJECT.md §5.4, 차별점 D5).
 * 사람용 문구(reason)와 함께 기계가 읽을 code·next_action을 돌려준다.
 */
export const REJECTION_CODES = {
  PAYEE_MISMATCH: "판매자에게 주문 재발급을 요청하고, 반복되면 이 판매자와 거래를 중단한다",
  AMOUNT_OVER_INTENT: "판매자에게 견적을 다시 확인한다",
  OVER_LIMIT: "사람(주인)에게 보고한다. 한도는 에이전트가 바꿀 수 없다",
  TYPED_DATA_MISMATCH: "결제를 중단하고 사람(주인)에게 보고한다",
  CHAIN_OR_TOKEN_NOT_ALLOWED: "판매자에게 허용된 체인·토큰(USDC)으로 주문을 요청한다",
  EXPIRED: "판매자에게 새 주문을 요청한다",
  DUPLICATE: "이미 결제한 주문이다. 다시 결제하지 않는다",
  // 아래 세 개는 §5.4 표에 없던 것. PROJECT.md 표에 추가 제안
  SIGNATURE_INVALID: "결제를 중단하고 사람(주인)에게 보고한다",
  INVALID_INPUT: "입력 형식을 고쳐 다시 호출한다",
  TICKET_INVALID: "지갑의 pay 도구로 처음부터 다시 결제한다 (signer에 직접 서명을 요청할 수 없다)",
} as const;

export type RejectionCode = keyof typeof REJECTION_CODES;
export type Step = "input" | "policy" | "typed_data" | "ticket" | "signature";

export interface Rejection {
  ok: false;
  code: RejectionCode;
  step: Step;
  reason: string;
  next_action: string;
}

export function reject(code: RejectionCode, step: Step, reason: string): Rejection {
  return { ok: false, code, step, reason, next_action: REJECTION_CODES[code] };
}
