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
  // 11/24 지갑 MCP 서버와 함께 추가
  WALLET_PAUSED: "주인이 결제를 정지했다. 정지가 풀릴 때까지 결제하지 말고 사람(주인)에게 알린다",
  HSP_ERROR: "잠시 후 같은 주문으로 다시 시도하고, 계속 실패하면 판매자에게 새 주문을 요청한다",
  SIGNER_UNAVAILABLE: "서명 프로세스가 꺼져 있다. 사람(주인)에게 signer 실행을 요청한다",
  NEEDS_OWNER_APPROVAL:
    "주인 확인을 기다린다. 결제는 아직 안 됐다. 1~2분 뒤 같은 order_ref·intent로 pay_order를 다시 부르거나, 다른 판매자를 찾는다",
  OWNER_REJECTED: "주인이 이 주문을 거절했다. 같은 주문은 결제하지 말고 다른 판매자를 찾거나 사람(주인)에게 묻는다",
  WITHDRAW_FAILED: "출금이 되지 않았다. 잔액·가스(주인 0번 계정 ETH)를 확인하고 다시 시도한다",
  POLICY_INVALID: "정책 파일을 읽을 수 없다. 결제하지 말고 사람(주인)에게 알린다",
} as const;

export type RejectionCode = keyof typeof REJECTION_CODES;
export type Step = "input" | "pause" | "policy" | "hsp" | "typed_data" | "ticket" | "signature" | "withdraw";

export interface Rejection {
  ok: false;
  code: RejectionCode;
  step: Step;
  reason: string;
  next_action: string;
  /** NEEDS_OWNER_APPROVAL: 주인 앱의 요청 id */
  request_id?: string;
}

export function reject(code: RejectionCode, step: Step, reason: string): Rejection {
  return { ok: false, code, step, reason, next_action: REJECTION_CODES[code] };
}
