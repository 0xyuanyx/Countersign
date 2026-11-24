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
| `POST /api/pause` `{reason?}` | 없음 | 결제 정지. 지갑 MCP와 signer 둘 다 다음 결제부터 `PAUSED`로 거부 |
| `POST /api/resume` | `Authorization: Bearer <주인 토큰>` | 결제 재개 |

- `checks`: 필드 6개 대조표 `[{field: payee|amount|chain|token|expiry|signer, result: match|mismatch|unchecked, expected?, actual?}]`. 주문을 못 읽은 거부(없는 주문 등)에는 없다.
- `events`: HSP 단계별 시각 `[{stage: signed|finalized|submitted|pending|payment-safe|payment-finalized|failed, at}]`. 결제까지 간 항목에만 있다.
- 거부 코드는 `PROJECT.md` §5.4. 긴급 정지 중에는 `PAUSED`.
- 정지는 안전한 방향이라 토큰 없이 누를 수 있다. 재개만 토큰이 필요하다 (에이전트가 스스로 정지를 풀 수 없게).
- 주인 토큰: `COUNTERSIGN_OWNER_TOKEN` 또는 `~/.countersign/owner.token`(없으면 처음 실행 때 0600으로 만든다).
- CORS: `COUNTERSIGN_APP_ORIGIN`(쉼표로 여러 개, 기본 `http://localhost:5173`)에만 허용.
- 정책 변경은 지갑 MCP와 signer가 **다음 결제부터 바로** 반영한다 (재시작 불필요, 파일이 바뀌면 다시 읽음). 정책 파일이 깨지면 둘 다 `POLICY_INVALID`로 거부한다.
- `agent`·`accountIndex`(서명 계정)는 바꿀 수 없다 (signer가 시작할 때 키를 정함). `sellers`는 통째로 바꾸므로 기존 판매자도 같이 보낸다.
