import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount, parseUint } from "./amount.js";

describe("amount", () => {
  it("USDC 6자리로 변환한다", () => {
    expect(parseAmount("0.10")).toBe(100_000n);
    expect(parseAmount("5")).toBe(5_000_000n);
    expect(parseAmount("0.000001")).toBe(1n);
    expect(parseAmount("123.456789")).toBe(123_456_789n);
  });
  it("반올림하지 않고 거부한다", () => {
    expect(() => parseAmount("0.0000001")).toThrow();
  });
  it("이상한 형식을 거부한다", () => {
    for (const s of ["", "-1", "+1", "1e3", "01", ".5", "5.", "0x10", " 1", "1,000", "NaN"]) {
      expect(() => parseAmount(s), s).toThrow();
    }
  });
  it("format은 parse의 역이다", () => {
    for (const s of ["0", "0.1", "5", "123.456789", "1000000"]) expect(formatAmount(parseAmount(s))).toBe(s);
  });
  it("parseUint는 10진·hex·안전 정수만 받는다", () => {
    expect(parseUint("100000")).toBe(100000n);
    expect(parseUint("0xff")).toBe(255n);
    expect(parseUint(7)).toBe(7n);
    for (const v of ["007", "1.5", "-1", 1.5, -1, 2 ** 60, null, "", "0x"]) expect(() => parseUint(v), String(v)).toThrow();
    expect(() => parseUint(`0x1${"0".repeat(64)}`)).toThrow();
  });
});
