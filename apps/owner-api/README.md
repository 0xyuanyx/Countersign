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
| `POST /api/tasks/:id/cancel` | 그만두기 (이후 그 일로는 결제 거절) |
| `GET /api/agents` | `{agents:[{id, name, created_at, disconnected_at?, connected, paused, paused_at?, last_activity_at?}]}` (토큰은 안 줌) |
| `POST /api/agents {name}` | 새 연결. `{id, name, token, connect:{url, claude_connector, claude_code, codex, cursor}}` — **토큰이 든 주소는 이때 한 번만** 준다 |
| `POST /api/agents/:id/disconnect` | 연결 끊기. 그 주소는 바로 401 |
| `PATCH /api/agents/:id {name}` | 이름 바꾸기 (살아 있는 다른 연결과 같은 이름이면 409). 내역의 활동 기록은 연결 id로 이어진다 |
| `POST /api/agents/:id/pause` / `resume` | 이 에이전트 하나만 멈추기·다시 켜기. 멈춘 동안 그 연결로 들어온 `pay_order`는 `WALLET_PAUSED` (열려 있던 연결도 다음 결제부터). 응답·`GET /api/agents`에 `paused` |

- 연결 주소의 기준은 `COUNTERSIGN_PUBLIC_MCP_URL` (예: HTTPS 터널 주소, 기본 `http://127.0.0.1:7440`). 원격 MCP 서버는 `apps/wallet-mcp/src/main-http.ts`.
- 내역 `status`에 `pending`(주인 승인 대기)이 생겼다. 그 항목엔 `request_id`가 있고, `checks`의 payee 칸이 `needs_approval`(앱의 주황 칸).
- 정책 요약에 `approval_mode`(`unknown_seller` 기본 / `every_payment`)가 있다. `PATCH /api/policy {approvalMode}`로 바꾼다.

- 에이전트별 멈춤은 지갑 MCP(원격 연결 단위)에서 막는다. signer는 연결을 모르므로 전체 긴급 정지(`/api/pause`)만 직접 확인한다.
