import { describe, expect, it } from "vitest";
import { deriveAccount, derivationPath, isValidMnemonic, normalizeMnemonic } from "./keys.js";

// Ouryn-Wallet Keys.swift selfTest와 같은 테스트 니모닉 (공개 BIP-39 벡터)
const TEST_WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("keys (Ouryn과 같은 경로 m/44'/60'/0'/0/n)", () => {
  it("경로 문자열", () => {
    expect(derivationPath(0)).toBe("m/44'/60'/0'/0/0");
    expect(derivationPath(3)).toBe("m/44'/60'/0'/0/3");
    expect(() => derivationPath(-1)).toThrow();
    expect(() => derivationPath(1.5)).toThrow();
  });

  it("0번 주소가 Ouryn selfTest 정답(bip_utils로 계산)과 같다", () => {
    expect(deriveAccount(TEST_WORDS, 0).address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });

  it("1, 2번 주소가 Foundry cast(다른 구현)와 같다", () => {
    expect(deriveAccount(TEST_WORDS, 1).address).toBe("0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0");
    expect(deriveAccount(TEST_WORDS, 2).address).toBe("0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A");
  });

  it("Ouryn normalize처럼 대소문자·쉼표·줄바꿈을 정리한다", () => {
    const messy = TEST_WORDS.toUpperCase().replace(/ /g, ",\n ");
    expect(normalizeMnemonic(messy)).toBe(TEST_WORDS);
    expect(deriveAccount(messy, 0).address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });

  it("체크섬이 틀린 니모닉은 거부하고, 오류에 단어를 넣지 않는다", () => {
    const bad = TEST_WORDS.replace(/about$/, "abandon");
    expect(isValidMnemonic(bad)).toBe(false);
    try {
      deriveAccount(bad, 0);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain("abandon");
    }
  });

  // 실제 개발 니모닉은 키체인에서 셸 환경변수로 들어온 경우에만 확인한다. 값은 출력하지 않는다.
  const dev = process.env.OURYN_DEV_MNEMONIC;
  it.runIf(!!dev)("키체인 OURYN_DEV_MNEMONIC 0번 = PROJECT.md §4.4 공개 주소", () => {
    expect(deriveAccount(dev!, 0).address).toBe("0x0BcBbA445d135d64611AE553d4BFa04E961b3ecF");
  });
});
