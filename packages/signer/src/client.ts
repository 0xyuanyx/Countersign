import { connect } from "node:net";
import type { Ticket } from "@countersign/wallet-core";
import type { SignerResponse } from "./signer.js";

/** 지갑 MCP 쪽에서 쓰는 signer 클라이언트. 키는 모른다. 소켓으로 요청만 보낸다. */
export class SignerClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 10_000,
  ) {}

  address(): Promise<SignerResponse> {
    return this.request({ op: "address" });
  }

  signPayment(ticket: Ticket, typedData: unknown): Promise<SignerResponse> {
    return this.request({ op: "sign_payment", ticket, typedData });
  }

  private request(body: unknown): Promise<SignerResponse> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      let buf = "";
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("signer 응답 시간 초과"));
      }, this.timeoutMs);
      sock.setEncoding("utf8");
      sock.on("connect", () => sock.write(`${JSON.stringify(body)}\n`));
      sock.on("data", (c: string) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer);
        sock.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as SignerResponse);
        } catch {
          reject(new Error("signer 응답이 JSON이 아님"));
        }
      });
      sock.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`signer 연결 실패: ${e.message}`));
      });
    });
  }
}
