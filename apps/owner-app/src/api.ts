// 주인 API 클라이언트 (apps/owner-api/README.md). 모양은 서버 응답 그대로 둔다.

export type CheckField = "payee" | "amount" | "chain" | "token" | "expiry" | "signer";
export type CheckResult = "match" | "mismatch" | "needs_approval" | "unchecked";
export type Check = { field: string; result: CheckResult; expected?: string; actual?: string };

export type HistoryEntry = {
  id: string;
  at: number;
  order_ref: string;
  status: "paid" | "rejected" | "pending" | "failed";
  seller?: string;
  purpose?: string;
  amount?: string;
  pay_to?: string;
  chain_id?: number;
  code?: string;
  step?: string;
  reason?: string;
  next_action?: string;
  payment_id?: string;
  hsp_status?: string;
  tx_hash?: string;
  order_hash?: string;
  typed_data_hash?: string;
  checks?: Check[];
  agent?: string;
  task_id?: string;
  request_id?: string;
  events?: { stage: string; at: number }[];
};

export type PolicySummary = {
  agent: string;
  account?: string;
  chains: { chain_id: number; token: string }[];
  per_tx_max: string;
  daily_max: string;
  spent_24h: string;
  remaining_24h: string;
  sellers: { name: string; address: string }[];
  paused: boolean;
  paused_reason?: string;
  approval_mode?: "unknown_seller" | "every_payment";
  editable_by_agent: false;
};

export type PolicyFileJson = {
  agent: string;
  accountIndex: number;
  chains: number[];
  token: string;
  perTxMax: string;
  dailyMax: string;
  sellers: Record<string, string>;
  [k: string]: unknown;
};

export type PurchaseRequest = {
  id: string;
  order_ref: string;
  status: "pending" | "approved" | "rejected";
  reason: "unknown_seller" | "every_payment";
  seller: string;
  purpose: string;
  amount: string;
  amount_raw: string;
  pay_to: string;
  chain_id: number;
  token: string;
  order_expires_at: number;
  task_id?: string;
  agent?: string;
  created_at: number;
  decided_at?: number;
  remember?: boolean;
};

export type Task = {
  id: string;
  text: string;
  max_amount: string;
  max_amount_raw: string;
  status: "open" | "working" | "paid" | "done" | "failed" | "cancelled";
  agent?: string;
  order_refs: string[];
  note?: string;
  created_at: number;
  updated_at: number;
};

export type Agent = {
  id: string;
  name: string;
  created_at: number;
  disconnected_at?: number;
  connected: boolean;
  last_activity_at?: number;
  /** 이 에이전트만 멈춤 (지갑 서버가 지원할 때만 옴) */
  paused?: boolean;
};
/** POST /api/agents 응답. token·url은 이때 한 번만 온다 (비밀번호와 같다) */
export type NewAgent = {
  id: string;
  name: string;
  token: string;
  connect: { url: string; claude_connector: string; claude_code: string; codex: string; cursor: string };
};
export type Balance = { account?: string; balances: { chain_id: number; balance?: string; error?: string }[] };
export type PauseState = { paused: boolean; at: number; reason?: string };

export interface OwnerApi {
  readonly mock: boolean;
  /** 짝짓기 확인: 주소에 닿는지 + 토큰이 맞는지 */
  verify(): Promise<void>;
  policy(): Promise<PolicySummary>;
  policyFile(): Promise<PolicyFileJson>;
  patchPolicy(body: Partial<Pick<PolicyFileJson, "perTxMax" | "dailyMax" | "sellers" | "chains">> & { approvalMode?: string }): Promise<PolicySummary>;
  history(limit?: number): Promise<HistoryEntry[]>;
  balance(): Promise<Balance>;
  pause(reason?: string): Promise<PauseState>;
  resume(): Promise<PauseState>;
  requests(status?: "pending" | "approved" | "rejected"): Promise<PurchaseRequest[]>;
  approve(id: string, remember?: boolean): Promise<PurchaseRequest>;
  reject(id: string): Promise<PurchaseRequest>;
  tasks(): Promise<Task[]>;
  createTask(text: string, maxAmount: string): Promise<Task>;
  cancelTask(id: string): Promise<Task>;
  agents(): Promise<Agent[]>;
  createAgent(name: string): Promise<NewAgent>;
  disconnectAgent(id: string): Promise<Agent>;
  /** 아래 둘은 지갑 서버에 아직 없을 수 있다 → 404 "없는 경로"면 UNSUPPORTED */
  renameAgent(id: string, name: string): Promise<Agent>;
  pauseAgent(id: string, paused: boolean): Promise<Agent>;
}

export const UNSUPPORTED = "지갑 서버가 아직 이 기능을 지원하지 않아요";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class HttpOwnerApi implements OwnerApi {
  readonly mock = false;
  /** base가 빈 문자열이면 앱과 같은 주소의 /api (Vite가 주인 API로 넘겨 줌) */
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, auth = method !== "GET"): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...(body !== undefined && { "Content-Type": "application/json" }),
          ...(auth && { Authorization: `Bearer ${this.token}` }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        cache: "no-store",
      });
    } catch {
      throw new ApiError(0, "지갑 서버에 닿지 않아요");
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    // 앱 서버(Vite 프록시·터널)는 살아 있는데 주인 API가 꺼져 있으면 502~504가 온다
    if (res.status >= 502 && res.status <= 504) throw new ApiError(0, "지갑 서버에 닿지 않아요");
    if (res.status === 404 && data.error === "없는 경로") throw new ApiError(404, UNSUPPORTED);
    if (!res.ok) throw new ApiError(res.status, data.error ?? `오류 ${res.status}`);
    return data as T;
  }

  async verify(): Promise<void> {
    await this.call("GET", "/api/policy");
    // 읽기 API는 토큰이 필요 없어서, 토큰이 맞는지는 없는 요청을 거절해 보는 걸로 확인한다 (401 = 토큰 틀림, 404 = 토큰 맞음)
    try {
      await this.call("POST", "/api/requests/pairing_check/reject", {});
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return;
      if (e instanceof ApiError && e.status === 401) throw new ApiError(401, "연결 코드가 맞지 않아요");
      throw e;
    }
  }
  policy = () => this.call<PolicySummary>("GET", "/api/policy");
  policyFile = () => this.call<PolicyFileJson>("GET", "/api/policy/file");
  patchPolicy = (body: object) => this.call<PolicySummary>("PATCH", "/api/policy", body);
  history = async (limit = 50) => (await this.call<{ entries: HistoryEntry[] }>("GET", `/api/history?limit=${limit}`)).entries;
  balance = () => this.call<Balance>("GET", "/api/balance");
  pause = (reason?: string) => this.call<PauseState>("POST", "/api/pause", reason ? { reason } : {}, false);
  resume = () => this.call<PauseState>("POST", "/api/resume", {});
  requests = async (status?: string) =>
    (await this.call<{ requests: PurchaseRequest[] }>("GET", `/api/requests${status ? `?status=${status}` : ""}`)).requests;
  approve = (id: string, remember?: boolean) =>
    this.call<PurchaseRequest>("POST", `/api/requests/${encodeURIComponent(id)}/approve`, remember ? { remember: true } : {});
  reject = (id: string) => this.call<PurchaseRequest>("POST", `/api/requests/${encodeURIComponent(id)}/reject`, {});
  tasks = async () => (await this.call<{ tasks: Task[] }>("GET", "/api/tasks")).tasks;
  createTask = (text: string, maxAmount: string) => this.call<Task>("POST", "/api/tasks", { text, maxAmount });
  cancelTask = (id: string) => this.call<Task>("POST", `/api/tasks/${encodeURIComponent(id)}/cancel`, {});
  agents = async () => (await this.call<{ agents: Agent[] }>("GET", "/api/agents")).agents;
  createAgent = (name: string) => this.call<NewAgent>("POST", "/api/agents", { name });
  disconnectAgent = (id: string) => this.call<Agent>("POST", `/api/agents/${encodeURIComponent(id)}/disconnect`, {});
  renameAgent = (id: string, name: string) => this.call<Agent>("PATCH", `/api/agents/${encodeURIComponent(id)}`, { name });
  pauseAgent = (id: string, paused: boolean) => this.call<Agent>("POST", `/api/agents/${encodeURIComponent(id)}/${paused ? "pause" : "resume"}`, {});
}

/** 정책 요약의 체인 번호들 */
export function chainIds(p: PolicySummary | undefined): number[] {
  return (p?.chains ?? []).map((c) => (typeof c === "number" ? c : c.chain_id));
}

export const CHAIN_NAME: Record<number, string> = { 133: "HSK 테스트넷", 177: "HSK 메인넷" };

/** 거부 코드 → 사람 말 (PROJECT.md §5.4) */
export const CODE_TEXT: Record<string, { title: string; short: string }> = {
  PAYEE_MISMATCH: { title: "받는 주소가 바뀐 청구서예요", short: "받는 주소가 달라요" },
  AMOUNT_OVER_INTENT: { title: "맡긴 금액보다 비싼 청구서예요", short: "맡긴 금액을 넘었어요" },
  OVER_LIMIT: { title: "한도를 넘는 결제예요", short: "한도를 넘었어요" },
  TYPED_DATA_MISMATCH: { title: "서명할 내용이 주문과 달라요", short: "서명 내용이 달라요" },
  CHAIN_OR_TOKEN_NOT_ALLOWED: { title: "허용하지 않은 체인이나 토큰이에요", short: "허용 안 된 체인·토큰" },
  EXPIRED: { title: "만료된 주문이에요", short: "주문이 만료됐어요" },
  DUPLICATE: { title: "이미 결제한 주문이에요", short: "이미 결제한 주문" },
  SIGNATURE_INVALID: { title: "서명자가 이 지갑이 아니에요", short: "서명자가 달라요" },
  TICKET_INVALID: { title: "검증을 거치지 않은 서명 요청이에요", short: "검증 없이 서명 요청" },
  INVALID_INPUT: { title: "에이전트가 보낸 형식이 잘못됐어요", short: "형식 오류" },
  WALLET_PAUSED: { title: "긴급 정지 중이라 막았어요", short: "긴급 정지 중" },
  HSP_ERROR: { title: "HSP에서 주문을 확인하지 못했어요", short: "HSP 확인 실패" },
  SIGNER_UNAVAILABLE: { title: "서명기가 꺼져 있어요", short: "서명기 꺼짐" },
  POLICY_INVALID: { title: "정책 파일에 문제가 있어요", short: "정책 오류" },
  NEEDS_OWNER_APPROVAL: { title: "처음 보는 판매자예요", short: "주인 확인 대기" },
  OWNER_REJECTED: { title: "내가 거절한 구매예요", short: "내가 거절함" },
};
