import { validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

/**
 * HD 키 파생. Ouryn-Wallet `Keys.swift` 의 standard 방식과 같은 경로를 쓴다:
 *   이더리움 m/44'/60'/0'/0/n  (MetaMask와 같음)
 * 0번은 주인(개발) 계정, 1, 2, … 번이 에이전트 계정이다 (PROJECT.md §4.4).
 *
 * 이 모듈은 니모닉을 "받아서" 계산만 한다. 키체인·환경변수에서 니모닉을 읽는 일은 signer만 한다 (AGENTS.md 규칙 6).
 */
export const MAX_ACCOUNT_INDEX = 1000;

export function derivationPath(index: number): `m/44'/60'/0'/0/${number}` {
  assertIndex(index);
  return `m/44'/60'/0'/0/${index}`;
}

/** Ouryn `Keys.normalize` 와 같은 정규화: 소문자, 공백·줄바꿈·탭·쉼표로 나눈 뒤 공백 하나로 잇는다. */
export function normalizeMnemonic(words: string): string {
  return words
    .toLowerCase()
    .split(/[ \n\t,]+/)
    .filter(Boolean)
    .join(" ");
}

export function isValidMnemonic(words: string): boolean {
  return validateMnemonic(normalizeMnemonic(words), english);
}

export function deriveAccount(mnemonic: string, index: number): HDAccount {
  assertIndex(index);
  const m = normalizeMnemonic(mnemonic);
  // 오류 메시지에 니모닉을 넣지 않는다
  if (!validateMnemonic(m, english)) throw new Error("니모닉이 BIP-39 형식이 아님");
  return mnemonicToAccount(m, { path: derivationPath(index) });
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_ACCOUNT_INDEX) {
    throw new Error(`계정 번호는 0~${MAX_ACCOUNT_INDEX} 정수`);
  }
}
