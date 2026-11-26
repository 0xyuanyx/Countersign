import { connect } from "node:net";
import type { Ticket } from "@countersign/wallet-core";
import type { SignerResponse } from "./signer.js";

/** 지갑 MCP 쪽에서 쓰는 signer 클라이언트. 키는 모른다. 소켓으로 요청만 보낸다. */
export class SignerClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 10_000,
    /** 원격 연결 id. 없으면 1번 로컬 에이전트 */
    private readonly agent?: string,
  ) {}

  /** 같은 소켓, 다른 에이전트 */
  forAgent(agent: string | undefined): SignerClient {
    return new SignerClient(this.socketPath, this.timeoutMs, agent && agent !== "local" ? agent : undefined);
  }

  address(): Promise<SignerResponse> {
    return this.request({ op: "address", ...this.who() });
  }

  signPayment(ticket: Ticket, typedData: unknown): Promise<SignerResponse> {
    return this.request({ op: "sign_payment", ...this.who(), ticket, typedData });
  }

  /** 주인 API 전용: 이 에이전트의 USDC를 주인 0번 계정으로 (amount 최소 단위, 없으면 전액) */
  withdrawToOwner(ownerToken: string, amount?: bigint, requestId?: string): Promise<SignerResponse> {
    return this.request(
      {
        op: "withdraw_to_owner",
        ...this.who(),
        ownerToken,
        ...(amount !== undefined && { amount: amount.toString() }),
        ...(requestId && { requestId }),
      },
      140_000,
    );
  }

  private who() {
    return this.agent ? { agent: this.agent } : {};
  }

  private request(body: unknown, timeoutMs = this.timeoutMs): Promise<SignerResponse> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      let buf = "";
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("signer 응답 시간 초과"));
      }, timeoutMs);
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
