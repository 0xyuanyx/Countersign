import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical.js";

describe("canonicalize", () => {
  it("키를 정렬하고 공백을 없앤다", () => {
    expect(canonicalize({ b: 1, a: { d: [1, "x"], c: null } })).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
  });
  it("키 순서가 달라도 결과가 같다", () => {
    expect(canonicalize({ x: "1", y: true })).toBe(canonicalize({ y: true, x: "1" }));
  });
  it("undefined 속성은 빠진다", () => {
    expect(canonicalize({ a: undefined, b: "v" })).toBe('{"b":"v"}');
  });
  it("bigint, 소수, 큰 수, NaN은 거부한다", () => {
    expect(() => canonicalize({ a: 1n })).toThrow();
    expect(() => canonicalize({ a: 0.1 })).toThrow();
    expect(() => canonicalize({ a: 2 ** 60 })).toThrow();
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
    expect(() => canonicalize([undefined])).toThrow();
    expect(() => canonicalize({ d: new Date() })).toThrow();
  });
  it("유니코드 문자열은 JSON 이스케이프 규칙을 따른다", () => {
    expect(canonicalize({ k: "결제\n" })).toBe('{"k":"결제\\n"}');
  });
});
