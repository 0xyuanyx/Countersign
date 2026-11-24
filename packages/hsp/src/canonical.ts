/**
 * Canonical JSON: 해시·서명 대상 JSON은 반드시 이 함수를 거친다 (AGENTS.md 코드 규칙).
 *
 * 규칙 (RFC 8785 JCS의 부분집합):
 * - 객체 키는 UTF-16 코드 단위 순서로 정렬, 공백 없음
 * - 값이 undefined인 객체 속성은 빠진다 (JSON.stringify와 같음)
 * - 숫자는 안전 정수만 허용. 금액·큰 수는 문자열로 넘긴다
 * - bigint, NaN/Infinity, 함수, 배열 안의 undefined는 오류 (조용히 바꾸지 않는다)
 */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

export function canonicalize(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`canonicalize: ${path} 숫자는 안전 정수만 허용 (금액은 문자열로)`);
      }
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((v, i) => {
            if (v === undefined) throw new TypeError(`canonicalize: ${path}[${i}] undefined`);
            return encode(v, `${path}[${i}]`);
          })
          .join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalize: ${path} 일반 객체가 아님`);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalize: ${path} 지원하지 않는 타입 ${typeof value}`);
  }
}
