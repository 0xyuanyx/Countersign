import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { reject } from "@countersign/wallet-core";
import type { Signer } from "./signer.js";

/**
 * 로컬 유닉스 소켓 서버. 한 줄에 JSON 요청 하나, 한 줄에 JSON 응답 하나.
 * 소켓 파일은 0600, 폴더는 0700 (같은 사용자만 접속). 네트워크 포트는 열지 않는다.
 * 요청 본문은 로그에 남기지 않는다.
 */
export const MAX_REQUEST_BYTES = 64 * 1024;

export async function listen(signer: Signer, socketPath: string): Promise<Server> {
  // macOS 유닉스 소켓 경로 한도는 104바이트
  if (Buffer.byteLength(socketPath) > 100) throw new Error(`소켓 경로가 너무 김 (100바이트 이하): ${socketPath}`);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) throw new Error(`소켓 경로에 다른 파일이 있음: ${socketPath}`);
    unlinkSync(socketPath);
  }
  const server = createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    // 출금은 영수증을 최대 90초 기다린다 → 연결은 그보다 넉넉히 (11/27 리뷰 P2-6)
    conn.setTimeout(150_000, () => conn.destroy());
    conn.on("data", (chunk: string) => {
      buf += chunk;
      if (Buffer.byteLength(buf) > MAX_REQUEST_BYTES) {
        conn.end(`${JSON.stringify(reject("INVALID_INPUT", "input", "요청이 너무 큼"))}\n`);
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void respond(line).then((out) => conn.write(`${out}\n`));
      }
    });
    conn.on("error", () => conn.destroy());
  });

  async function respond(line: string): Promise<string> {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      return JSON.stringify(reject("INVALID_INPUT", "input", "JSON이 아님"));
    }
    try {
      return JSON.stringify(await signer.handle(req));
    } catch {
      return JSON.stringify(reject("INVALID_INPUT", "input", "처리 중 오류"));
    }
  }

  await new Promise<void>((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o600);
  return server;
}
