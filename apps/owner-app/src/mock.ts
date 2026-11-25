// 지갑 서버 없이 화면을 보는 데모 데이터 (pnpm dev:mock, 또는 연결 화면에서 "데모로 둘러보기").
// 샘플 값은 design/README.md "2026-11-25 검토 반영"과 맞춘다: 잔액 24.80, 오늘 1.30 / 5.00, 데모 상품 상권 리포트(area-report).
// 주소·해시는 데모용으로 만든 값이다.

import type { Agent, Balance, NewAgent, Check, HistoryEntry, OwnerApi, PauseState, PolicyFileJson, PolicySummary, PurchaseRequest, Task } from "./api.js";
import { ApiError } from "./api.js";

const AREA = "0x3f9A2bC40e5D71a8F6B2c09E4d1A7b3C5E81c21E";
const AREA_FAKE = "0x3f9A27d1B09aF4c6E2d8b1F0A5c3E7d29081c21E";
const NEWS = "0x5D18aE0c3B47f92D6a1C8e05F3b9A7d24E6c0B91";
const MAPS = "0xA07c41De9B3f58a2C6E1d0B4f97A3e5C82D16f4B";
const WEATHER = "0x9B2e61c0F4a8D37e5B19aC02F6d8E1a7b3d047dA";
const USDC = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6";

const ok = (field: string, expected?: string): Check => ({ field, result: "match", ...(expected && { expected, actual: expected }) });
const allOk = (payTo: string, amount: string): Check[] => [
  ok("payee", payTo),
  ok("amount", `${amount} USDC`),
  ok("chain", "133"),
  ok("token", "USDC"),
  ok("expiry"),
  ok("signer"),
];
const hex = (n: number, seed: number) => {
  let s = "";
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += "0123456789abcdef"[x % 16];
  }
  return `0x${s}`;
};

/** 오늘 hh:mm:ss의 unix초 */
const at = (h: number, m: number, s = 0) => {
  const d = new Date();
  d.setHours(h, m, s, 0);
  return Math.floor(d.getTime() / 1000);
};

function paid(id: string, t: number, seller: string, purpose: string, amount: string, payTo: string, taskId: string, seed: number): HistoryEntry {
  return {
    id,
    at: t,
    order_ref: `ord_${id}`,
    status: "paid",
    seller,
    purpose,
    amount,
    pay_to: payTo,
    chain_id: 133,
    payment_id: `pay_${id}`,
    hsp_status: "payment-finalized",
    tx_hash: hex(64, seed),
    order_hash: hex(64, seed + 1),
    typed_data_hash: hex(64, seed + 2),
    checks: allOk(payTo, amount),
    agent: "purchase-agent-1",
    task_id: taskId,
    events: [
      { stage: "signed", at: t - 3 },
      { stage: "finalized", at: t - 2 },
      { stage: "submitted", at: t - 2 },
      { stage: "payment-safe", at: t - 1 },
      { stage: "payment-finalized", at: t },
    ],
  };
}

export class MockOwnerApi implements OwnerApi {
  readonly mock = true;
  private paused: PauseState = { paused: false, at: 0 };
  private sellers: Record<string, string> = { "area-report": AREA, "news-digest": NEWS, "map-tiles": MAPS };
  private perTxMax = "0.5";
  private dailyMax = "5";
  private hist: HistoryEntry[];
  private reqs: PurchaseRequest[];
  private taskList: Task[];

  private agentList: Agent[];
  private startBalance = 26.1;

  /** fresh: 처음 연결 흐름을 보려고 에이전트·내역·잔액 없이 시작 (주소에 ?fresh) */
  constructor(fresh = false) {
    const now = Math.floor(Date.now() / 1000);
    this.agentList = fresh ? [] : [{ id: "conn_1", name: "purchase-agent-1", created_at: at(9, 0), connected: true, last_activity_at: now - 30 }];
    // 데모 흐름이 "방금" 일어난 것처럼 보이게 시각을 지금 기준으로 둔다
    const t0 = now - 70;
    this.taskList = [
      task("task_gangnam", "강남역 상권 리포트 사 와", "0.25", "paid", t0 - 60, ["ord_rej1", "ord_p5"]),
      task("task_weather", "내일 서울 날씨 데이터 사 와", "0.50", "working", now - 30, ["ord_weather"]),
      task("task_news", "오늘 뉴스 3건 요약해 와", "0.50", "done", at(16, 55), ["ord_p4"]),
      task("task_week", "이번 주 뉴스 묶음 사 와", "2.00", "failed", at(15, 0), ["ord_rej2"]),
      task("task_seongsu", "성수동 상권 리포트 사 와", "0.25", "done", at(14, 38), ["ord_p2"]),
      task("task_maps", "서울역 주변 지도 타일 받아 와", "0.50", "done", at(11, 0), ["ord_p1"]),
    ];
    this.hist = [
      paid("p5", t0 + 5, "area-report", "강남역 상권 리포트 1건", "0.1", AREA, "task_gangnam", 5),
      {
        id: "rej1",
        at: t0,
        order_ref: "ord_7Q2fA81c91",
        status: "rejected",
        seller: "area-report",
        purpose: "강남역 상권 리포트 1건",
        amount: "0.1",
        pay_to: AREA_FAKE,
        chain_id: 133,
        code: "PAYEE_MISMATCH",
        step: "payee",
        reason: "pay_to가 area-report의 고정 주소가 아님",
        next_action: "판매자에게 주문 재발급 요청",
        order_hash: hex(64, 11),
        checks: [
          { field: "payee", result: "mismatch", expected: AREA, actual: AREA_FAKE },
          { field: "amount", result: "unchecked" },
          { field: "chain", result: "unchecked" },
          { field: "token", result: "unchecked" },
          { field: "expiry", result: "unchecked" },
          { field: "signer", result: "unchecked" },
        ],
        agent: "purchase-agent-1",
        task_id: "task_gangnam",
      },
      paid("p4", at(16, 58), "news-digest", "뉴스 요약 3건", "0.3", NEWS, "task_news", 4),
      {
        id: "rej2",
        at: at(15, 2),
        order_ref: "ord_rej2",
        status: "rejected",
        seller: "news-digest",
        purpose: "이번 주 뉴스 묶음",
        amount: "1.2",
        pay_to: NEWS,
        chain_id: 133,
        code: "OVER_LIMIT",
        step: "amount",
        reason: "1.20 > 1회 한도 0.50",
        next_action: "사람에게 보고",
        checks: [
          ok("payee", NEWS),
          { field: "amount", result: "mismatch", expected: "≤ 0.50 USDC", actual: "1.20 USDC" },
          { field: "chain", result: "unchecked" },
          { field: "token", result: "unchecked" },
          { field: "expiry", result: "unchecked" },
          { field: "signer", result: "unchecked" },
        ],
        agent: "purchase-agent-1",
        task_id: "task_week",
      },
      paid("p2", at(14, 40), "area-report", "성수동 상권 리포트 1건", "0.1", AREA, "task_seongsu", 2),
      paid("p1", at(11, 2), "map-tiles", "지도 타일 묶음", "0.5", MAPS, "task_maps", 1),
    ];
    this.reqs = [
      {
        id: "req_weather",
        order_ref: "ord_weather",
        status: "pending",
        reason: "unknown_seller",
        seller: "weather-feed",
        purpose: "서울 7일 예보 1건",
        amount: "0.3",
        amount_raw: "300000",
        pay_to: WEATHER,
        chain_id: 133,
        token: USDC,
        order_expires_at: now + 272,
        task_id: "task_weather",
        agent: "purchase-agent-1",
        created_at: now - 28,
      },
    ];
    this.hist.unshift({
      id: "pend1",
      at: now - 28,
      order_ref: "ord_weather",
      status: "pending",
      seller: "weather-feed",
      purpose: "서울 7일 예보 1건",
      amount: "0.3",
      pay_to: WEATHER,
      chain_id: 133,
      code: "NEEDS_OWNER_APPROVAL",
      request_id: "req_weather",
      checks: [
        { field: "payee", result: "needs_approval", actual: WEATHER },
        ok("amount", "0.30 USDC"),
        ok("chain", "133"),
        ok("token", "USDC"),
        ok("expiry"),
        { field: "signer", result: "unchecked" },
      ],
      agent: "purchase-agent-1",
      task_id: "task_weather",
    });
    if (fresh) {
      this.hist = [];
      this.reqs = [];
      this.taskList = [];
      this.sellers = {};
      this.startBalance = 0;
    }
  }

  private spent(): number {
    const day = at(0, 0);
    return this.hist.filter((e) => e.status === "paid" && e.at >= day).reduce((s, e) => s + Number(e.amount ?? 0), 0);
  }
  private delay<T>(v: T, ms = 120): Promise<T> {
    return new Promise((r) => setTimeout(() => r(structuredClone(v)), ms));
  }

  async verify() {}
  async policy(): Promise<PolicySummary> {
    const spent = this.spent();
    return this.delay({
      agent: "purchase-agent-1",
      account: "0x71C95911E9a5D330f4D621842EC243EE13433a2F",
      chains: [{ chain_id: 133, token: USDC }],
      per_tx_max: this.perTxMax,
      daily_max: this.dailyMax,
      spent_24h: String(Number(spent.toFixed(6))),
      remaining_24h: String(Number((Number(this.dailyMax) - spent).toFixed(6))),
      sellers: Object.entries(this.sellers).map(([name, address]) => ({ name, address })),
      paused: this.paused.paused,
      ...(this.paused.reason && { paused_reason: this.paused.reason }),
      approval_mode: "unknown_seller",
      editable_by_agent: false,
    });
  }
  async policyFile(): Promise<PolicyFileJson> {
    return this.delay({ agent: "purchase-agent-1", accountIndex: 1, chains: [133], token: "USDC", perTxMax: this.perTxMax, dailyMax: this.dailyMax, sellers: this.sellers });
  }
  async patchPolicy(body: { perTxMax?: string; dailyMax?: string; sellers?: Record<string, string> }) {
    if (body.perTxMax) this.perTxMax = body.perTxMax;
    if (body.dailyMax) this.dailyMax = body.dailyMax;
    if (body.sellers) this.sellers = { ...body.sellers };
    return this.policy();
  }
  async history(limit = 50) {
    return this.delay([...this.hist].sort((a, b) => b.at - a.at).slice(0, limit));
  }
  async balance(): Promise<Balance> {
    // 시작 잔액 26.10에서 오늘 쓴 돈을 뺀다 → 구매 요청을 승인하면 24.80 · 오늘 1.30 (디자인 샘플 값)
    return this.delay({ account: "0x71C95911E9a5D330f4D621842EC243EE13433a2F", balances: [{ chain_id: 133, balance: Math.max(0, this.startBalance - this.spent()).toFixed(2) }] });
  }
  async pause(reason?: string) {
    this.paused = { paused: true, at: Math.floor(Date.now() / 1000), ...(reason && { reason }) };
    return this.delay(this.paused);
  }
  async resume() {
    this.paused = { paused: false, at: Math.floor(Date.now() / 1000) };
    return this.delay(this.paused);
  }
  async requests(status?: string) {
    const now = Math.floor(Date.now() / 1000);
    return this.delay(this.reqs.filter((r) => (!status || r.status === status) && (r.status !== "pending" || r.order_expires_at > now)));
  }
  async approve(id: string, remember?: boolean) {
    const r = this.reqs.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "없는 요청");
    if (r.status !== "pending") throw new ApiError(409, `이미 결정됨 (${r.status})`);
    const now = Math.floor(Date.now() / 1000);
    if (r.order_expires_at <= now) throw new ApiError(410, "주문이 이미 만료됨");
    r.status = "approved";
    r.decided_at = now;
    if (remember) {
      this.sellers[r.seller] = r.pay_to;
      r.remember = true;
    }
    // 에이전트가 같은 주문으로 다시 pay를 부르면 결제된다 (데모: 1.5초 뒤)
    setTimeout(() => {
      this.hist = this.hist.filter((e) => e.request_id !== id);
      this.hist.unshift({ ...paid("pw", Math.floor(Date.now() / 1000), r.seller, r.purpose, r.amount, r.pay_to, r.task_id ?? "", 9), order_ref: r.order_ref });
      const t = this.taskList.find((x) => x.id === r.task_id);
      if (t) t.status = "paid";
    }, 1500);
    return this.delay(r);
  }
  async reject(id: string) {
    const r = this.reqs.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "없는 요청");
    if (r.status !== "pending") throw new ApiError(409, `이미 결정됨 (${r.status})`);
    r.status = "rejected";
    r.decided_at = Math.floor(Date.now() / 1000);
    const e = this.hist.find((x) => x.request_id === id);
    if (e) {
      e.status = "rejected";
      e.code = "OWNER_REJECTED";
      e.next_action = "같은 주문 결제 금지, 다른 판매자";
      e.checks = e.checks?.map((c) => (c.field === "payee" ? { ...c, result: "mismatch" } : c));
    }
    const t = this.taskList.find((x) => x.id === r.task_id);
    if (t) t.status = "failed";
    return this.delay(r);
  }
  async tasks() {
    return this.delay([...this.taskList].sort((a, b) => b.created_at - a.created_at));
  }
  async createTask(text: string, maxAmount: string) {
    const now = Math.floor(Date.now() / 1000);
    const t = task(`task_${now}`, text, maxAmount, "open", now, []);
    this.taskList.unshift(t);
    return this.delay(t);
  }
  async cancelTask(id: string) {
    const t = this.taskList.find((x) => x.id === id);
    if (!t) throw new ApiError(404, "없는 일");
    t.status = "cancelled";
    return this.delay(t);
  }
  async agents(): Promise<Agent[]> {
    return this.delay(this.agentList);
  }
  async createAgent(name: string): Promise<NewAgent> {
    const now = Math.floor(Date.now() / 1000);
    const id = `conn_${this.agentList.length + 1}`;
    this.agentList.push({ id, name, created_at: now, connected: true });
    const token = "demo_" + Math.random().toString(36).slice(2, 14);
    const url = `https://wallet.example/mcp/${token}`;
    return this.delay({
      id,
      name,
      token,
      connect: {
        url,
        claude_connector: url,
        claude_code: `claude mcp add --transport http countersign-${name} ${url}`,
        codex: `codex mcp add countersign-${name} --url ${url}`,
        cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=countersign-${name}&config=demo`,
      },
    });
  }
  private agent(id: string): Agent {
    const a = this.agentList.find((x) => x.id === id);
    if (!a) throw new ApiError(404, "없는 연결");
    return a;
  }
  async disconnectAgent(id: string) {
    const a = this.agent(id);
    a.connected = false;
    a.disconnected_at = Math.floor(Date.now() / 1000);
    return this.delay({ ...a });
  }
  async renameAgent(id: string, name: string) {
    if (this.agentList.some((x) => x.name === name && x.id !== id && x.connected)) throw new ApiError(409, "같은 이름의 연결이 이미 있어요");
    const a = this.agent(id);
    a.name = name;
    return this.delay({ ...a });
  }
  async pauseAgent(id: string, paused: boolean) {
    const a = this.agent(id);
    a.paused = paused;
    return this.delay({ ...a });
  }
}

function task(id: string, text: string, max: string, status: Task["status"], t: number, orders: string[]): Task {
  return {
    id,
    text,
    max_amount: max,
    max_amount_raw: String(Math.round(Number(max) * 1e6)),
    status,
    agent: "purchase-agent-1",
    order_refs: orders,
    created_at: t,
    updated_at: t,
  };
}
