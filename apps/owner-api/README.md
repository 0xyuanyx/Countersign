# 주인 API (PWA 앱용)

사람(주인)이 쓰는 로컬 HTTP API. 에이전트용 지갑 MCP와 따로 돈다. `127.0.0.1:7420`에만 열린다.

```bash
COUNTERSIGN_POLICY=apps/demo/policy.testnet.json node_modules/.bin/tsx apps/owner-api/src/main.ts
```

| 메서드·경로 | 인증 | 응답 |
|---|---|---|
| `GET /api/policy` | 없음 | 정책 요약: `agent, account, chains[], per_tx_max, daily_max, spent_24h, remaining_24h, sellers[{name,address}], paused, paused_reason?, editable_by_agent:false` (금액은 "0.5" 같은 USDC 문자열) |
| `GET /api/history?limit=20` | 없음 | `{entries:[...]}` 최신순. 항목: `id, at(unix초), order_ref, status(paid/rejected/failed), seller?, purpose?, amount?, pay_to?, chain_id?, code?, step?, reason?, next_action?, payment_id?, hsp_status?, tx_hash?, order_hash?, typed_data_hash?` |
| `GET /api/pause` | 없음 | `{paused, at, reason?}` |
| `POST /api/pause` `{reason?}` | 없음 | 결제 정지. 지갑 MCP와 signer 둘 다 다음 결제부터 `PAUSED`로 거부 |
| `POST /api/resume` | `Authorization: Bearer <주인 토큰>` | 결제 재개 |

- 정지는 안전한 방향이라 토큰 없이 누를 수 있다. 재개만 토큰이 필요하다 (에이전트가 스스로 정지를 풀 수 없게).
- 주인 토큰: `COUNTERSIGN_OWNER_TOKEN` 또는 `~/.countersign/owner.token`(없으면 처음 실행 때 0600으로 만든다).
- CORS: `COUNTERSIGN_APP_ORIGIN`(쉼표로 여러 개, 기본 `http://localhost:5173`)에만 허용.
- 한도·판매자 같은 정책 값을 바꾸는 API는 없다. 정책 파일을 주인이 고치고 signer를 다시 켠다.
