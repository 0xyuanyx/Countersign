import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 비밀값 읽기: 환경변수 → 프로젝트 .env → 맥 키체인 순서 (사용자 전역 규칙).
 * 이 파일은 signer 패키지에만 있다. 지갑 MCP 서버와 에이전트 코드는 이 함수를 쓰지 않는다 (AGENTS.md 규칙 6).
 * 값은 절대 로그·오류 메시지에 넣지 않는다.
 */
export function loadSecret(name: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("비밀값 이름 형식이 아님");
  const env = opts.env ?? process.env;
  const fromEnv = env[name];
  if (fromEnv) return fromEnv;

  const fromDotenv = readDotenv(join(opts.cwd ?? process.cwd(), ".env"))[name];
  if (fromDotenv) return fromDotenv;

  if (process.platform === "darwin") {
    try {
      const v = execFileSync("security", ["find-generic-password", "-a", env.USER ?? "", "-s", name, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (v) return v;
    } catch {
      // 없음 → 아래에서 이름만 알린다
    }
  }
  throw new Error(`비밀값 ${name}을 찾지 못함 (환경변수, .env, 키체인 순서로 찾음)`);
}

function readDotenv(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) out[m[1]!] = v;
  }
  return out;
}
