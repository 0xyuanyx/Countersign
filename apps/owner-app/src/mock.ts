// 지갑 서버 없이 화면을 보는 데모 데이터 (pnpm dev:mock, 또는 연결 화면에서 "데모로 둘러보기").
// 샘플 값은 design/README.md "2026-11-25 검토 반영"과 맞춘다: 잔액 24.80, 오늘 1.30 / 5.00, 데모 상품 상권 리포트(area-report).
// 주소·해시는 데모용으로 만든 값이다.

import type { Agent, Balance, NewAgent, Check, HistoryEntry, OwnerApi, PauseState, PolicyFileJson, PolicySummary, PurchaseRequest, Task, TaskResult } from "./api.js";
import { ApiError } from "./api.js";

const AREA = "0x3f9A2bC40e5D71a8F6B2c09E4d1A7b3C5E81c21E";
const AREA_FAKE = "0x3f9A27d1B09aF4c6E2d8b1F0A5c3E7d29081c21E";
const NEWS = "0x5D18aE0c3B47f92D6a1C8e05F3b9A7d24E6c0B91";
const MAPS = "0xA07c41De9B3f58a2C6E1d0B4f97A3e5C82D16f4B";
const WEATHER = "0x9B2e61c0F4a8D37e5B19aC02F6d8E1a7b3d047dA";
const AIR = "0x2C81f0aB7d3E95c4A6e1D08b5F2c9A3e7B14d6E0";
const HOTEL = "0x6E3a9D1c0B57f2A8e4C6d1F09b3A5e7C28D4f1B9";
// Ethereum Sepolia의 Circle 테스트 USDC
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const ok = (field: string, expected?: string): Check => ({ field, result: "match", ...(expected && { expected, actual: expected }) });
const allOk = (payTo: string, amount: string): Check[] => [
  ok("payee", payTo),
  ok("amount", `${amount} USDC`),
  ok("chain", "11155111"),
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
    chain_id: 11155111,
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
  /** 데모는 에이전트가 같은 계정·정책을 같이 쓴다 (전환은 이름만 바뀜) */
  agentId?: string;
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
  constructor(private fresh = false) {
    const now = Math.floor(Date.now() / 1000);
    this.agentList = fresh ? [] : [{ id: "conn_1", name: "purchase-agent-1", created_at: at(9, 0), connected: true, last_activity_at: now - 30 }];
    // 데모 흐름이 "방금" 일어난 것처럼 보이게 시각을 지금 기준으로 둔다
    const t0 = now - 70;
    this.taskList = [
      task("task_gangnam", "강남역 상권 리포트 사 와", "0.25", "paid", t0 - 60, ["ord_rej1", "ord_p5"]),
      task("task_weather", "내일 서울 날씨 데이터 사 와", "0.50", "open", now - 30, []),
      task("task_news", "오늘 뉴스 3건 요약해 와", "0.50", "done", at(16, 55), ["ord_p4"]),
      task("task_week", "이번 주 뉴스 묶음 사 와", "2.00", "failed", at(15, 0), ["ord_rej2"]),
      task("task_seongsu", "성수동 상권 리포트 사 와", "0.25", "done", at(14, 38), ["ord_p2"]),
      task("task_maps", "서울역 주변 지도 타일 받아 와", "0.50", "done", at(11, 0), ["ord_p1"]),
    ];
    // 출장 비서 데모: 끝났지만 아직 확인 안 한 일 (홈에 결과 카드로 남는다)
    const trip = task("task_tokyo", "12/07~08 도쿄 출장 항공권·숙박 예매 (09시 이후 출발, 8일 19시 전 도착, 회의 Shinjuku Sample Tower)", "1.50", "done", now - 25, ["ord_air", "ord_hotel"]);
    trip.updated_at = now - 15;
    trip.result = TOKYO_RESULT;
    this.taskList.unshift(trip);
    for (const t of this.taskList) if (t.id !== "task_tokyo" && ["paid", "done", "failed"].includes(t.status)) t.acknowledged_at = t.updated_at;
    this.hist = [
      {
        ...paid("air", now - 20, "Sample Air", "도쿄 왕복 항공권 CS101·CS102", "0.42", AIR, "task_tokyo", 21),
        receipt: {
          title: "Sample Air 도쿄 왕복",
          kind: "flight",
          confirmation: "CS7Q2K",
          lines: [
            { label: "가는 편", value: "CS101 · 12/07 10:25 인천 → 13:05 하네다" },
            { label: "오는 편", value: "CS102 · 12/08 15:50 하네다 → 18:35 인천" },
            { label: "수하물", value: "위탁 23kg 1개" },
            { label: "결제", value: "0.42 USDC" },
          ],
        },
      },
      {
        ...paid("hotel", now - 18, "Hotel Sample Shinjuku", "Hotel Sample Shinjuku 1박", "0.38", HOTEL, "task_tokyo", 23),
        receipt: {
          title: "Hotel Sample Shinjuku 1박",
          kind: "hotel",
          confirmation: "HSS-48213",
          lines: [
            { label: "체크인", value: "12/07 15:00" },
            { label: "체크아웃", value: "12/08 11:00" },
            { label: "회의 장소까지", value: "150m · 도보 2분" },
            { label: "평점", value: "4.4 / 5" },
            { label: "결제", value: "0.38 USDC" },
          ],
        },
      },
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
        chain_id: 11155111,
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
        chain_id: 11155111,
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
    this.reqs = [];
    if (fresh) {
      this.hist = [];
      this.reqs = [];
      this.taskList = [];
      this.startBalance = 0;
    }
  }

  private demoUsed = false;

  /**
   * 데모의 "처음 보는 판매자" 구매 요청. 처음부터 있으면 비밀번호를 만들자마자 승인 시트가 떠서,
   * 홈을 잠깐 본 뒤(main.ts) 또는 일을 맡긴 뒤에 들어오게 한다. 한 번만.
   */
  demoRequest(taskId = "task_weather", maxAmount = "0.5"): void {
    if (this.demoUsed) return;
    const t = this.taskList.find((x) => x.id === taskId);
    if (!t || (t.status !== "open" && t.status !== "working")) return;
    this.demoUsed = true;
    const now = Math.floor(Date.now() / 1000);
    const amount = String(Math.min(0.3, Number(maxAmount)));
    // 맡긴 일이 날씨가 아니면 판매자·설명도 그 일에 맞춘다
    const weather = taskId === "task_weather";
    const seller = weather ? "weather-feed" : "data-market";
    const purpose = weather ? "서울 7일 예보 1건" : "맡긴 일 자료 1건";
    const agent = this.agentList.find((a) => a.connected)?.name ?? "purchase-agent-1";
    t.status = "working";
    t.order_refs = ["ord_weather"];
    this.reqs.unshift({
      id: "req_weather",
      order_ref: "ord_weather",
      status: "pending",
      reason: "unknown_seller",
      seller,
      purpose,
      amount,
      amount_raw: String(Math.round(Number(amount) * 1e6)),
      pay_to: WEATHER,
      chain_id: 11155111,
      token: USDC,
      order_expires_at: now + 300,
      task_id: taskId,
      agent,
      agent_reason: weather
        ? "7일 예보를 파는 판매자 세 곳을 비교했어요. 다른 두 곳은 3일 예보만 있어서 여기를 골랐어요"
        : "맡긴 일에 맞는 자료를 파는 곳 중 가장 싸고, 샘플 데이터 형식이 요청과 맞았어요",
      created_at: now,
    });
    this.hist.unshift({
      id: "pend1",
      at: now,
      order_ref: "ord_weather",
      status: "pending",
      seller,
      purpose,
      amount,
      pay_to: WEATHER,
      chain_id: 11155111,
      code: "NEEDS_OWNER_APPROVAL",
      request_id: "req_weather",
      checks: [
        { field: "payee", result: "needs_approval", actual: WEATHER },
        ok("amount", `${Number(amount).toFixed(2)} USDC`),
        ok("chain", "11155111"),
        ok("token", "USDC"),
        ok("expiry"),
        { field: "signer", result: "unchecked" },
      ],
      agent,
      task_id: taskId,
    });
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
      chains: [{ chain_id: 11155111, token: USDC }],
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
    return this.delay({ agent: "purchase-agent-1", accountIndex: 1, chains: [11155111], token: "USDC", perTxMax: this.perTxMax, dailyMax: this.dailyMax, sellers: this.sellers });
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
    return this.delay({ account: "0x71C95911E9a5D330f4D621842EC243EE13433a2F", balances: [{ chain_id: 11155111, balance: Math.max(0, this.startBalance - this.spent()).toFixed(2) }] });
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
      this.hist.unshift({ ...paid("pw", Math.floor(Date.now() / 1000), r.seller, r.purpose, r.amount, r.pay_to, r.task_id ?? "", 9), order_ref: r.order_ref, agent: r.agent });
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
    // 데모 각본 (에이전트가 청구서를 받아 오는 데 2.5초):
    // 첫 일 → 처음 보는 판매자라 구매 요청, 다음 일 → 등록된 판매자 이름에 다른 주소(바꿔치기)를 막고 진짜 주소로 다시 결제, 그다음부터는 바로 결제
    setTimeout(() => this.runTask(t, maxAmount), 2500);
    return this.delay(t);
  }
  private mismatchShown = false;
  private runTask(t: Task, maxAmount: string): void {
    if (t.status !== "open") return;
    if (!this.demoUsed) {
      const old = this.taskList.find((x) => x.id === "task_weather");
      if (old && old.status === "open") old.status = "cancelled";
      return this.demoRequest(t.id, maxAmount);
    }
    const agent = this.agentList.find((a) => a.connected)?.name ?? "purchase-agent-1";
    const amt = String(Math.min(0.1, Number(maxAmount)));
    const n = Math.floor(Date.now() / 1000);
    const pay = () => {
      const m = Math.floor(Date.now() / 1000);
      t.status = "paid";
      t.order_refs.push(`ord_p${m}`);
      this.hist.unshift({ ...paid(`p${m}`, m, "area-report", "상권 리포트 1건", amt, AREA, t.id, m % 97), order_ref: `ord_p${m}`, agent });
    };
    t.status = "working";
    if (this.mismatchShown) return pay();
    this.mismatchShown = true;
    t.order_refs.push(`ord_f${n}`);
    this.hist.unshift({
      id: `rej${n}`,
      at: n,
      order_ref: `ord_f${n}`,
      status: "rejected",
      seller: "area-report",
      purpose: "상권 리포트 1건",
      amount: amt,
      pay_to: AREA_FAKE,
      chain_id: 11155111,
      code: "PAYEE_MISMATCH",
      step: "payee",
      reason: "pay_to가 area-report의 고정 주소가 아님",
      next_action: "판매자에게 주문 재발급 요청",
      order_hash: hex(64, n % 89),
      checks: [
        { field: "payee", result: "mismatch", expected: AREA, actual: AREA_FAKE },
        { field: "amount", result: "unchecked" },
        { field: "chain", result: "unchecked" },
        { field: "token", result: "unchecked" },
        { field: "expiry", result: "unchecked" },
        { field: "signer", result: "unchecked" },
      ],
      agent,
      task_id: t.id,
    });
    // 에이전트가 새 청구서를 받아 진짜 주소로 다시 결제
    setTimeout(pay, 5000);
  }

  /** 데모 입금: 주인이 "가짜 USDC 받기"를 누르면 잔액이 생긴다 (빈 지갑일 때만) */
  demoEmpty(): boolean {
    return this.startBalance - this.spent() <= 0;
  }
  demoDeposit(): void {
    if (this.demoEmpty()) this.startBalance = this.spent() + 26.1;
  }

  /** 데모 연결: 주인이 "붙였어요"를 누르면 에이전트가 붙은 것처럼 (실제 지갑은 첫 활동이 있어야 연결됨) */
  demoAttach(id: string): void {
    const a = this.agentList.find((x) => x.id === id);
    if (a && !a.last_activity_at) a.last_activity_at = Math.floor(Date.now() / 1000);
  }

  async pauseTask(id: string, paused: boolean) {
    const t = this.taskList.find((x) => x.id === id);
    if (!t) throw new ApiError(404, "없는 일");
    t.status = paused ? "paused" : t.order_refs.length ? "working" : "open";
    return this.delay({ ...t });
  }
  async ackTask(id: string) {
    const t = this.taskList.find((x) => x.id === id);
    if (!t) throw new ApiError(404, "없는 일");
    t.acknowledged_at = Math.floor(Date.now() / 1000);
    return this.delay({ ...t });
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
  async agentDetail(id: string) {
    return this.delay({ agent: { ...this.agent(id) }, policy: await this.policy(), balance: await this.balance() });
  }
  async catalog() {
    const c = (id: string, label: string, scenario: string, scenario_label: string, price: string) => ({ id, label, task_text: label, scenario, scenario_label, price });
    return this.delay([
      { id: "tokyo-trip", label: "12/07~08 도쿄 출장 항공권·숙박 예매", task_text: "12/07~08 도쿄 출장 가. 09시 이후 출발, 8일 19시 전 도착. 항공권과 숙박 예매해 줘. 회의 장소는 Shinjuku Sample Tower야", scenario: "compare", scenario_label: "비교해서 고르기", suggested_max_amount: "1.00" },
      c("w", "내일 서울 날씨 예보 사 와", "normal", "정상", "0.10"),
      c("fx", "오늘 원·달러 환율 데이터 사 와", "normal", "정상", "0.10"),
      c("nw", "오늘 주요 뉴스 요약 사 와", "new_seller", "처음 보는 판매자", "0.10"),
      c("ps", "역삼동 상권 리포트 사 와", "payee_swap", "받는 주소 바꿔치기", "0.25"),
      c("as", "지도 타일 묶음 사 와", "amount_swap", "금액 부풀리기", "0.10"),
      c("inj", "경제 지표 데이터 사 와", "injection", "프롬프트 인젝션", "0.10"),
    ]);
  }
  async hideAgent(id: string) {
    this.agent(id).hidden = true;
    return this.delay(true);
  }
  async withdraw(): Promise<never> {
    throw new ApiError(400, "데모라 출금은 하지 않아요");
  }
}

const TOKYO_RESULT: TaskResult = {
  summary: "도쿄 출장 항공권과 숙소를 예약했어요",
  weather: {
    place: "도쿄",
    days: [
      { date: "2026-12-07", sky: "sun", high: 12, low: 4, rain_pct: 10 },
      { date: "2026-12-08", sky: "rain", high: 10, low: 6, rain_pct: 70 },
    ],
    advice: { clothing: "아침저녁 4~6도라 코트나 두꺼운 겉옷을 챙기세요", umbrella: true, note: "8일은 비 70%, 오후에 많이 와요" },
  },
  picks: [
    {
      kind: "flight",
      label: "항공권",
      total: 3,
      criteria: ["09시 이후 출발", "8일 19시 전 도착", "값"],
      chosen: { name: "Sample Air CS101", detail: "12/07 10:25 인천 → 13:05 하네다 · 오는 편 12/08 18:35 인천 도착", price: "0.42", facts: [{ label: "출발", value: "10:25" }, { label: "도착", value: "18:35" }], history_id: "air" },
      others: [
        { name: "DJ201", detail: "12/07 08:10 출발", price: "0.35", facts: [{ label: "출발", value: "08:10" }, { label: "도착", value: "17:50" }], reason: "08:10 출발이라 09시 이후 조건에 안 맞아요" },
        { name: "BW301", detail: "12/08 21:45 인천 도착", price: "0.31", facts: [{ label: "출발", value: "11:40" }, { label: "도착", value: "21:45" }], reason: "8일 21:45 도착이라 19시 전 도착 조건에 안 맞아요" },
      ],
    },
    {
      kind: "hotel",
      label: "숙박",
      total: 4,
      criteria: ["회의 장소까지 거리", "값(1박 0.50 이하)"],
      chosen: { name: "Hotel Sample Shinjuku", detail: "회의 장소까지 150m · 1박", price: "0.38", facts: [{ label: "회의 장소까지", value: "150m" }], history_id: "hotel" },
      others: [
        { name: "Shinjuku Station Hotel", detail: "회의 장소까지 600m", price: "0.36", facts: [{ label: "회의 장소까지", value: "600m" }], reason: "값은 비슷한데 회의 장소까지 4배 멀어요" },
        { name: "Nishi-Shinjuku Inn", detail: "회의 장소까지 1.2km", price: "0.32", facts: [{ label: "회의 장소까지", value: "1.2km" }], reason: "가장 싸지만 회의 장소까지 1.2km라 걸어서 15분이에요" },
        { name: "Shinjuku Grand", detail: "회의 장소까지 300m", price: "0.72", facts: [{ label: "회의 장소까지", value: "300m" }], reason: "1박 0.72로 예산(0.50)을 넘어요" },
      ],
    },
  ],
};

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
