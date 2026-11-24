/**
 * 문자열 ↔ bigint 금액 변환은 이 파일에서만 한다 (AGENTS.md 코드 규칙).
 * 반올림하지 않는다. 표현할 수 없는 값은 오류로 거부한다.
 */
export const USDC_DECIMALS = 6;

const DECIMAL_RE = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
const UINT_DEC_RE = /^(0|[1-9]\d*)$/;
const UINT_HEX_RE = /^0x[0-9a-fA-F]{1,64}$/;
const UINT256_MAX = (1n << 256n) - 1n;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

/** "0.10" → 100000n (USDC). 소수 자릿수가 decimals를 넘으면 거부 (잘라내지 않음). */
export function parseAmount(text: string, decimals = USDC_DECIMALS): bigint {
  if (typeof text !== "string") throw new AmountError("금액은 문자열이어야 함");
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new AmountError(`금액 형식이 아님: ${JSON.stringify(text.slice(0, 40))}`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new AmountError(`소수 자릿수 초과 (최대 ${decimals})`);
  const v = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (v > UINT256_MAX) throw new AmountError("uint256 범위 초과");
  return v;
}

/** 100000n → "0.1" */
export function formatAmount(value: bigint, decimals = USDC_DECIMALS): string {
  if (value < 0n) throw new AmountError("음수 금액");
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * 최소 단위 정수(EIP-712 uint 필드, HSP 금액)를 bigint로. 10진 정수 문자열, 0x hex, 안전 정수만 받는다.
 * 앞자리 0("007")이나 소수, 음수는 거부한다.
 */
export function parseUint(value: unknown): bigint {
  let v: bigint;
  if (typeof value === "bigint") v = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new AmountError("안전 정수가 아님");
    v = BigInt(value);
  } else if (typeof value === "string" && (UINT_DEC_RE.test(value) || UINT_HEX_RE.test(value))) {
    v = BigInt(value);
  } else {
    throw new AmountError("uint 형식이 아님");
  }
  if (v < 0n || v > UINT256_MAX) throw new AmountError("uint256 범위 밖");
  return v;
}

/** bigint → 10진 문자열 (해시·로그용) */
export function uintToString(value: bigint): string {
  if (value < 0n) throw new AmountError("음수");
  return value.toString(10);
}
