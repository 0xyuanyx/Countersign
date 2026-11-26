# 주인 API (PWA 앱용)

사람(주인)이 쓰는 로컬 HTTP API. 에이전트용 지갑 MCP와 따로 돈다. `127.0.0.1:7420`에만 열린다.

```bash
COUNTERSIGN_POLICY=apps/demo/policy.testnet.json node_modules/.bin/tsx apps/owner-api/src/main.ts
```

| 메서드·경로 | 인증 | 응답 |
|---|---|---|
| `GET /api/policy` | 없음 | 정책 요약: `agent, account, chains[], per_tx_max, daily_max, spent_24h, remaining_24h, sellers[{name,address}], paused, paused_reason?, editable_by_agent:false` (금액은 "0.5" 같은 USDC 문자열) |
| `GET /api/policy/file` | 없음 | 정책 파일 원본 `{agent, accountIndex, chains, token, perTxMax, dailyMax, sellers{이름:주소}, tokenAddresses?, maxAuthorizationSeconds?}` (편집 화면 초기값) |
| `PATCH /api/policy` | `Authorization: Bearer <주인 토큰>` | 바꿀 항목만: `{perTxMax?, dailyMax?, sellers?, chains?, tokenAddresses?\|null, maxAuthorizationSeconds?\|null}`. 성공하면 새 정책 요약(GET /api/policy와 같은 모양), 실패하면 400 `{ok:false, error}`이고 파일은 그대로 |
| `GET /api/history?limit=20` | 없음 | `{entries:[...]}` 최신순. 항목: `id, at(unix초), order_ref, status(paid/rejected/failed), seller?, purpose?, amount?, pay_to?, chain_id?, code?, step?, reason?, next_action?, payment_id?, hsp_status?, tx_hash?, order_hash?, typed_data_hash?, checks?, events?` |
| `GET /api/balance` | 없음 | `{account, balances:[{chain_id, balance?("0.1"), error?}]}` (입금·홈 화면) |
| `GET /api/pause` | 없음 | `{paused, at, reason?}` |
| `POST /api/pause` `{reason?}` | 없음 | 결제 정지. 지갑 MCP와 signer 둘 다 다음 결제부터 `WALLET_PAUSED`로 거부 |
| `POST /api/resume` | `Authorization: Bearer <주인 토큰>` | 결제 재개 |

- `checks`: 필드 6개 대조표 `[{field: payee|amount|chain|token|expiry|signer, result: match|mismatch|unchecked, expected?, actual?}]`. 주문을 못 읽은 거부(없는 주문 등)에는 없다.
- `events`: HSP 단계별 시각 `[{stage: signed|finalized|submitted|pending|payment-safe|payment-finalized|failed, at}]`. 결제까지 간 항목에만 있다.
- 거부 코드는 `PROJECT.md` §5.4. 긴급 정지 중에는 `WALLET_PAUSED`.
- 정지는 안전한 방향이라 토큰 없이 누를 수 있다. 재개만 토큰이 필요하다 (에이전트가 스스로 정지를 풀 수 없게).
- 주인 토큰: `COUNTERSIGN_OWNER_TOKEN` 또는 `~/.countersign/owner.token`(없으면 처음 실행 때 0600으로 만든다).
- CORS: `COUNTERSIGN_APP_ORIGIN`(쉼표로 여러 개, 기본 `http://localhost:5173`)에만 허용.
- **공개 모드** (`COUNTERSIGN_OWNER_API_PUBLIC=1`): 맥의 HTTPS 터널(`apps/demo/tunnel.sh`)로 인터넷에 열 때 쓴다. 위 표에서 "없음"인 읽기와 `POST /api/pause`까지 **모든 요청에 주인 토큰**을 요구한다 (CORS는 브라우저만 막고 curl은 못 막아서, 열어 두면 누구나 내역을 읽고 지갑을 멈출 수 있다). 브라우저 사전 요청(OPTIONS)만 토큰 없이 답한다. 이때 `COUNTERSIGN_APP_ORIGIN`은 Vercel 앱 주소 하나만 둔다.
- 정책 변경은 지갑 MCP와 signer가 **다음 결제부터 바로** 반영한다 (재시작 불필요, 파일이 바뀌면 다시 읽음). 정책 파일이 깨지면 둘 다 `POLICY_INVALID`로 거부한다.
- `agent`·`accountIndex`(서명 계정)는 바꿀 수 없다 (signer가 시작할 때 키를 정함). `sellers`는 통째로 바꾸므로 기존 판매자도 같이 보낸다.

## 폰 앱용 (11/25 추가: 구매 요청·맡기기·에이전트 연결)

쓰기(POST)는 모두 `Authorization: Bearer <주인 토큰>`이 필요하다.

| 메서드·경로 | 응답 |
|---|---|
| `GET /api/requests?status=pending` | `{requests:[{id, order_ref, status(pending/approved/rejected), reason(unknown_seller/every_payment), seller, purpose, amount, amount_raw, pay_to, chain_id, token, order_expires_at, task_id?, agent?, created_at, decided_at?, remember?}]}` 최신순 |
| `POST /api/requests/:id/approve {remember?}` | 승인. `remember:true`면 "다음부터 묻지 않기": 판매자 이름 → 이 주문 주소로 정책 `sellers`에 등록 (같은 이름이 다른 주소로 있으면 409). 만료된 주문은 410 |
| `POST /api/requests/:id/reject` | 거절. 에이전트가 같은 주문으로 다시 부르면 `OWNER_REJECTED` |
| `GET /api/tasks` | `{tasks:[{id, text, max_amount, max_amount_raw, status(open/working/paid/done/failed/cancelled), agent?, order_refs[], note?, created_at, updated_at}]}` |
| `POST /api/tasks {text, maxAmount}` | 맡기기. 지갑과 signer가 이 일로 하는 결제를 `maxAmount`로 막는다 (에이전트가 적은 값은 안 믿음). 글은 부탁일 뿐 정책을 못 바꾼다 |
| `POST /api/tasks/:id/pause` | 이 일만 멈추기 → `status:"paused"`(바뀐 Task). 멈춘 일은 `next_task`로 안 주고, 그 `task_id`로 온 `pay_order`는 `TASK_PAUSED`, 그 일의 구매 요청 승인은 409 |
| `POST /api/tasks/:id/resume` | 다시 켜기: 결제가 끝난 일은 `paid`, 청구서(주문)가 이미 있으면 `working`, 없으면 `open` |
| `POST /api/tasks/:id/cancel` | 그만두기. 이후 그 일로는 결제 거절(`INVALID_INPUT`), 그 일에서 생긴 대기 중 구매 요청도 거절로 바꾼다 |
| `GET /api/agents` | `{agents:[{id, name, created_at, disconnected_at?, connected, paused, paused_at?, last_activity_at?}]}` (토큰은 안 줌) |
| `POST /api/agents {name}` | 새 연결. `{id, name, token, connect:{url, claude_connector, claude_code, codex, cursor}}` — **토큰이 든 주소는 이때 한 번만** 준다 |
| `POST /api/agents/:id/disconnect` | 연결 끊기. 그 주소는 바로 401 |
| `PATCH /api/agents/:id {name}` | 이름 바꾸기 (살아 있는 다른 연결과 같은 이름이면 409). 내역의 활동 기록은 연결 id로 이어진다 |
| `POST /api/agents/:id/pause` / `resume` | 이 에이전트 하나만 멈추기·다시 켜기. 멈춘 동안 그 연결로 들어온 `pay_order`는 `WALLET_PAUSED` (열려 있던 연결도 다음 결제부터). 응답·`GET /api/agents`에 `paused` |

- 연결 주소의 기준은 `COUNTERSIGN_PUBLIC_MCP_URL` (예: HTTPS 터널 주소, 기본 `http://127.0.0.1:7440`). 원격 MCP 서버는 `apps/wallet-mcp/src/main-http.ts`.
- 내역 `status`에 `pending`(주인 승인 대기)이 생겼다. 그 항목엔 `request_id`가 있고, `checks`의 payee 칸이 `needs_approval`(앱의 주황 칸).
- 정책 요약에 `approval_mode`(`unknown_seller` 기본 / `every_payment`)가 있다. `PATCH /api/policy {approvalMode}`로 바꾼다.

- 에이전트별 멈춤은 지갑 MCP(원격 연결 단위)에서 막는다. signer는 연결을 모르므로 전체 긴급 정지(`/api/pause`)만 직접 확인한다.

## 에이전트별 계정 (11/26: 실서비스 구조)

에이전트 연결 하나 = 계정 하나(니모닉 `m/44'/60'/0'/0/n`) + 정책 파일 하나 + 지출 기록 하나. 기존 1번 계정은 첫 에이전트이고 정책은 `COUNTERSIGN_POLICY` 파일 그대로다(11/26 이전에 만든 연결도 1번). 새 연결은 다음 번호를 받고, 기본 정책은 1회 0.5 · 하루 5 · 판매자 없음 · Ethereum Sepolia.

| 메서드·경로 | 응답 |
|---|---|
| `GET /api/agents` | `{agents:[{id, name, account_index, address, chain_id, active, connected, paused, attached_at?, last_seen_at?, last_activity_at?, created_at, disconnected_at?}]}`. `connected`는 끊기지 않았고 그 토큰으로 MCP에 실제로 붙은 적이 있을 때 true, `attached_at`은 MCP initialize에 처음 성공한 시각 |
| `POST /api/agents {name}` | 위 항목 + `token`, `connect{...}`, `deposit{address, chain_id, token, token_symbol, explorer_url}` |
| `GET /api/agents/:id` | `{agent, policy, balance, deposit}` 상세 화면 한 번에 |
| `GET /api/agents/:id/balance` | `{agent_id, address, chain_id, token, token_symbol, usdc, native, explorer_url}` 실제 RPC 잔액 (`native`는 가스용 ETH. 결제는 HSP가 가스를 내서 0이어도 됨) |
| `GET /api/agents/:id/policy` · `/policy/file` · `PATCH /api/agents/:id/policy` | 그 에이전트 정책 (본문은 전역 `/api/policy`와 같음, PATCH는 주인 토큰) |
| `GET /api/agents/:id/history?limit=` | 그 에이전트 내역만 |
| `PATCH /api/agents/:id {hidden}` | 주인 토큰. 목록에서 숨기기·다시 보이기. 숨기기는 **연결이 끊겼고 그 계정 USDC가 0일 때만** (아니면 400과 이유). 숨겨도 목록에는 `hidden:true`로 함께 내려가고, 정책·내역·결제 기록은 그대로다. `name`과 같이 보내도 된다 |
| `POST /api/agents/:id/withdraw {amount?, request_id?}` | 주인 토큰. `request_id`(영문 소문자·숫자·`-_` 8~64자)를 앱이 만들어 보내면, 응답이 끊겨 다시 눌러도 **한 번만** 나간다(같은 id면 새로 보내지 않고 그 거래 결과를 돌려줌). 응답 `status`: `done`(체인 확인) / `pending`(보냈는데 영수증 전, 같은 request_id로 다시 POST하면 이어서 확인). 같은 에이전트에 영수증 전 출금이 있으면 새 출금은 502. 내역 id = request_id (pending이면 `confirming`, 확인되면 `paid`로 갱신). 그 에이전트 USDC를 **주인 0번 계정으로만** 보낸다(받는 곳 고정, 빼면 전액). 한도·정지와 상관없이 된다. 실제 체인 거래 `{ok, tx_hash, explorer_url, amount, from, to, chain_id, token}`. 내역에 `kind:"withdraw"` |

- 전역 경로는 `?agent=<id>`(또는 `?agentId=`)를 받는다: `/api/policy`, `/api/policy/file`, `PATCH /api/policy`, `/api/balance`, `/api/history`, `/api/requests`, `/api/tasks`. 빼면 첫 에이전트(1번 계정).
- `POST /api/tasks {text, maxAmount, agentId?}`: `agentId`가 있으면 그 에이전트만 `next_task`로 받아 간다.
- 구매 요청 승인의 "다음부터 묻지 않기"는 요청한 에이전트의 정책 `sellers`에만 들어간다. 요청·내역 항목에 `agent_id`.
- 내역 결제 항목(`status:"paid"`, `kind:"payment"`)에는 `tx_hash`, `chain_id`, `from`이 있다. HSP mock 결제는 `simulated:true`(tx_hash 가짜, 탐색기 링크 없음). 실제 체인 거래(출금, 실제 HSP 결제)에만 `explorer_url`.
- 출금 거래: 에이전트 키로 EIP-3009 `TransferWithAuthorization`(→ 주인 0번)에 서명하고 주인 0번 계정이 가스를 내 제출한다. 그래서 주인 0번 계정에 Sepolia ETH가 조금 있어야 한다. 결제가 아니라서 HSP를 거치지 않는다.


## 맡기기 추천 칩 (11/26)

`GET /api/catalog[?agent=<id>]` → `{sellers:[{name, url, scenario, scenario_label, reachable, items[]}], chips:[{id, label, item, sku, price, seller, seller_url, scenario, scenario_label, exceeds_per_tx?, task_text}]}`

- `label`: 칩에 보일 한국어 부탁 문장 (예: "내일 서울 날씨 예보 사 와"), `task_text`: `POST /api/tasks`의 `text`로 그대로 쓰면 되는 문장(판매자 주소·상품·가격이 붙어 있어 에이전트가 어디서 살지 안다).
- `scenario`: 그 칩을 맡기면 지갑이 보여 줄 장면. `normal`(등록 판매자, 바로 결제), `new_seller`(처음 보는 판매자 → 승인 요청), `over_limit`(그 에이전트 1회 한도를 넘는 가격 → 거절, `?agent=`를 줄 때만 계산), `payee_swap`·`amount_swap`·`chain_swap`·`injection`(악성 판매자 → 거절).
- 판매자 목록은 `demo.sh`가 띄우는 6곳: data-mart :7430(상품 10개, 0.01~0.8), news-wire :7435(처음 보는 판매자, 3개), data-mart 사칭 악성 :7431~7434(3개씩). 다른 곳은 `COUNTERSIGN_CATALOG_SELLERS`로.
- 상품 납품물은 견본 데이터다(`sample:true`). 결제는 HSP 허용 전까지 mock.
