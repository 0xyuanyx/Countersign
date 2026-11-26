/**
 * HSP create_order의 cart_mandate (가이드 §6) 만들기·읽기.
 *
 * 가이드가 정한 것: amount.currency = "USD", merchant_authorization 없음, contents.id, contents.cart_expiry(RFC3339),
 * contents.payment_request.method_data[] (supported_methods = "https://www.x402.org/", data.x402Version = 2,
 * 네트워크·토큰 값은 get_chain_config에서), contents.payment_request.details.
 *
 * ⚠️ ASSUMED (§9 #8): method_data.data 안의 키 이름(network, chain_id, contract_address, coin)과 details 구조는
 * 가이드 본문과 x402 v2 관례를 따른 추측이다. IP 허용 뒤 라이브 create_order 입력 스키마로 이 파일만 맞춘다.
 * mock 서버도 이 파일로 읽기 때문에, mock 흐름은 이 모양이 맞다고 가정하고 돈다.
 */
export const X402_METHOD = "https://www.x402.org/";

export interface CartInput {
  id: string;
  /** 사람이 읽는 USD 금액 문자열 ("0.10"). USDC 1:1 */
  usd: string;
  /** 토큰 최소 단위 금액 (정수 문자열) */
  amountRaw: string;
  label: string;
  network: string;
  chainId: number;
  token: string;
  coin: string;
  payTo: string;
  expiresAt: Date;
}

export function buildCartMandate(c: CartInput) {
  const amount = { currency: "USD", value: c.usd };
  return {
    contents: {
      id: c.id,
      cart_expiry: c.expiresAt.toISOString(),
      payment_request: {
        method_data: [
          {
            supported_methods: X402_METHOD,
            data: {
              x402Version: 2,
              network: c.network,
              chain_id: c.chainId,
              contract_address: c.token,
              coin: c.coin,
              pay_to: c.payTo,
              amount_raw: c.amountRaw,
            },
          },
        ],
        details: {
          id: c.id,
          display_items: [{ label: c.label, amount }],
          total: { label: "Total", amount },
        },
      },
    },
  };
}

/** mock 서버가 create_order 입력을 읽을 때 쓴다 (실서버는 자기 방식으로 읽는다) */
export function readCartMandate(cart: unknown): {
  chainId: number;
  token: string;
  amountRaw: string;
  payTo?: string;
  label?: string;
  expiresAt?: number;
} {
  const c = cart as { contents?: { cart_expiry?: string; payment_request?: { method_data?: { supported_methods?: string; data?: Record<string, unknown> }[]; details?: { display_items?: { label?: string }[] } } } };
  const m = c?.contents?.payment_request?.method_data?.find((x) => x?.supported_methods === X402_METHOD);
  const d = m?.data ?? {};
  if (d.x402Version !== 2) throw new Error("cart_mandate: x402Version 2가 아님");
  const chainId = Number(d.chain_id);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("cart_mandate: chain_id 없음");
  if (typeof d.contract_address !== "string" || typeof d.amount_raw !== "string") throw new Error("cart_mandate: 토큰·금액 없음");
  const exp = c.contents?.cart_expiry ? Date.parse(c.contents.cart_expiry) : NaN;
  return {
    chainId,
    token: d.contract_address,
    amountRaw: d.amount_raw,
    ...(typeof d.pay_to === "string" && { payTo: d.pay_to }),
    ...(c.contents?.payment_request?.details?.display_items?.[0]?.label && { label: c.contents.payment_request.details.display_items[0].label }),
    ...(Number.isFinite(exp) && { expiresAt: Math.floor(exp / 1000) }),
  };
}

/** USDC 최소 단위(6자리) 정수 문자열 → "0.10" 같은 USD 문자열 (반올림 없음). 금액 계산이 아니라 표시 변환만 한다 */
export function rawToUsd(raw: string, decimals = 6): string {
  if (!/^\d+$/.test(raw)) throw new Error("raw 금액 형식이 아님");
  const s = raw.padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac.padEnd(2, "0")}` : `${whole}.00`;
}
