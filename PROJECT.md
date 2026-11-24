# Countersign — HSP 에이전트 결제용 서명 지갑

> 출품명 **Countersign** (2026-11-24 확정, 나중에 낼 정식 Ouryn 지갑과 엮이지 않게). 공개 저장소·패키지 이름은 `countersign-agent` / `@countersign/*`. 맥 로컬 폴더는 `~/Developer/Countersign` (11/24 ouryn-agent에서 이름 변경). README·발표에는 "Ouryn 지갑 설계에서 출발" 한 줄만 남긴다.
> 키체인 이름 `OURYN_DEV_MNEMONIC`·`OURYN_DEPLOYER_KEY`는 이미 저장된 값이라 그대로 쓰고, 나머지 환경변수는 `COUNTERSIGN_*`.

> HSK Chain Horizon Seoul Hackathon · **Track 2. Agent Payments & A2A Settlement (HSP)** 출품작
> 개인 출품(박태민 / 0xyuanyx). 같은 트랙 팀 출품작과는 별개 프로젝트 (§2.3 경계).
> 이 문서는 사람(태민)과 AI 협업자(GPT, Claude)가 같이 보는 **기준 문서**다. 방향이 바뀌면 이 문서부터 고친다.
> 최종 수정: 2026-11-24 (경쟁작 19개 분석 반영, §2·§4·§5·§6·§8·§9·§10 개정)

---

## 0. 반드시 지킬 해커톤 규칙 (원문)

- 국가와 지역에 관계없이 개인 또는 팀 단위로 참가할 수 있습니다.
- 모든 프로젝트는 독창적인 아이디어를 기반으로 하며, 해커톤 기간 중 새롭게 개발하거나 재구축한 결과물이어야 합니다.
- AI Agent Trading 또는 Agent Payments & A2A Settlement 중 하나의 트랙을 선택해야 합니다.
- 프로젝트는 HSK Chain 생태계를 기반으로 개발해야 합니다.
- 공식 권장 제품 및 프레임워크를 활용할 경우 평가 시 추가 점수를 받을 수 있습니다.
- 결제 트랙 참가자는 반드시 HSP를 활용해야 합니다.
- 프로젝트의 스마트 컨트랙트는 HSK Chain 메인넷에 배포해야 합니다. 메인넷 배포가 완료되지 않은 프로젝트는 데모 발표 대상에서 제외됩니다.
- 서울 현장에서 직접 발표할 수 있는 팀은 데모 발표팀 선정 시 우선 고려됩니다.

**일정**: 등록·제출 마감 **2026-12-03 13:00 KST** (동시 마감) · 12/4 데모팀 안내 · **12/5 서울 Demo Day** · 12/6 수상 발표
**상금**: 트랙당 6,000 USDT (1등 3,000 / 2등 2,000 / 3등 1,000). 상금 수령도 메인넷 배포가 조건.
**운영진 확인 완료**: 한 사람이 같은 트랙에 프로젝트 2개 제출 가능 (팀 출품과 병행 OK).

### 규칙 → 이 프로젝트에서 지키는 방법

| 규칙 | 대응 |
|---|---|
| 기간 중 새로 개발/재구축 | Ouryn-Wallet(iOS, Swift)의 지갑 코어 **설계와 검증 로직을 TypeScript로 재구축**. Swift 코드를 그대로 쓰지 않는다. README에 출처를 명시한다 |
| HSK Chain 생태계 | 증거 컨트랙트는 HSK Chain 메인넷(177). 결제는 HSP가 열어 준 네트워크에서 (§4.2, 서울 메인넷 HSP 여부 확인 중) |
| HSP 필수 | 모든 결제는 **HSP 공식 Agentic Payment MCP 서버**를 거친다. 직접 `transfer`로 우회하지 않는다 |
| 메인넷 컨트랙트 | `EvidenceRegistry` 컨트랙트를 HSK Chain 메인넷에 배포 (§6) |
| 공식 권장 제품 가산점 | HSP 공식 Agentic Payment MCP 서버를 핵심 경로로 사용 (§4.1) |
| 현장 발표 우선 | 12/5 서울 현장 발표 전제로 데모 준비 |

---

## 1. 한 줄 요약

**HSP 공식 MCP 서버가 돌려주는 결제 데이터를, 사람 클릭 없이도 안전하게 서명해 주는 에이전트 전용 지갑. 어떤 에이전트(Claude, GPT 등)든 MCP 한 줄로 붙인다.**

메시지: **"에이전트가 속아도 지갑은 안 속는다."**

## 2. 문제, 경쟁 상황, 차별점

### 2.1 문제

- 에이전트는 프롬프트 인젝션, 환각, 악성 판매 에이전트의 조작된 주문에 속을 수 있다.
- HSP 공식 MCP는 `prepare_payment`로 서명할 EIP-712 데이터를 돌려주고, **서명은 클라이언트 몫**으로 남겨 둔다. 그 자리에 누가 무엇을 확인하고 서명하는지가 비어 있다.
- 사람 지갑은 "서명 전에 사람이 화면을 보고 확인(clear signing)"으로 이걸 막는다. 에이전트 결제에는 그 사람이 없다.

### 2.2 경쟁작 분석 (2026-11-24, GitHub 공개 저장소 기준)

같은 트랙 저장소 19개를 읽었다. 서울 대회 출품작과 직전 뭄바이·인도 대회 출품작이 섞여 있다. 뒤의 것은 이미 심사를 받은 기준선으로 본다.

| 경쟁작 | 대회 | 하는 것 | 강점 | 우리가 넘어야 할 점 |
|---|---|---|---|---|
| [hsk-meter](https://github.com/swiftbotlabs/hsk-meter) | 인도 | API 호출당 결제, 환불 컨트랙트(메인넷), **공식 HSP MCP로 실결제 14건**(Sepolia 계열), 서명 방화벽 | 완성도 기준선: 테스트 561개, CI, 지갑 없이 해 보는 try 페이지, 주장별 VERIFIED/NOT-CLAIMED 표 | 정직한 주장 표와 테스트 밀도를 같은 수준으로. 이 팀은 자기 API 판매용이고, 남이 가져다 쓰는 지갑 제품은 아니다 |
| [leash](https://github.com/Tharun2075/leash) | **서울** | 에이전트 예산 컨트랙트(메인넷), 공식 HSP MCP 8개 도구 구현, `prepare_payment` 결과를 구매 내용과 대조, **결제마다 사람 승인** | 우리 원래 설계(서명 전 대조)와 거의 같다. 메인넷 배포 완료. HSP는 IP 허용 대기 중 | **결제마다 사람이 눌러야 해서 자율 결제가 아니다.** 한도는 팀 작품 영역이라 우리는 다루지 않는다 |
| [Tandem](https://github.com/k58v2hbzkk-del/Tandem) | **서울** | HSP 결제 1건을 에이전트 팀에 CREATE2 분배 | 아이디어가 명확 | 서명과 제출에 사람 승인 2번 |
| [proof-gated-payee](https://github.com/rezimx-btc/hsk-proof-gated-payee) | **서울** | 에스크로 + 검증 에이전트 5개 관문 | 컨트랙트 보안 설명 | 테스트넷만, 메인넷 배포 안 함, HSP 실연동 없음 |
| [hsk-horizon-agent-settlement](https://github.com/emiliotecnologias/hsk-horizon-agent-settlement) | **서울** | 에스크로 + 파이썬 에이전트 | 정직한 상태 표기 | 로컬 체인만, "HSP-style" 흉내 |
| [mandatesettle](https://github.com/phee24/mandatesettle) | 서울 추정 | EIP-712 mandate + 배송 조건 에스크로, 메인넷 | 서명 전 필드 대조 | 가짜 토큰, 공식 MCP는 QA 403으로 미연결 |
| [mandaterail-hsp](https://github.com/cocvn157/mandaterail-hsp) | 서울 추정 | fail-closed mandate, 심사위원용 콘솔 | 공격 6종 시뮬레이터 | 테스트넷만, HSP 실호출 없음, LLM 없음 |
| [ZyroXQ](https://github.com/vipinraj32/a2a-influencer-settlement) | 인도 | 인플루언서 거래 A2A, LangGraph | "LLM은 제안, 코드가 결정, 키가 서명" 원칙, 인젝션 플래그 | HSP 미연동, 미배포 |
| [agentsettle-hsk](https://github.com/0xultravioleta/agentsettle-hsk) | 뭄바이 | 자체 x402 facilitator(메인넷) + HSP 보조 | 생태계 기여(facilitator) | HSP는 보조 레일 |

**정리하면**
1. "서명 전에 EIP-712를 주문과 대조"는 이미 흔하다(hsk-meter, leash, mandatesettle). **단독 차별점이 될 수 없다.**
2. 서울 경쟁작 대부분이 **결제마다 사람 승인**을 넣거나, 아예 LLM 없이 스크립트 에이전트를 쓴다. 실제 LLM이 속는 장면을 보여 준 곳은 없다.
3. 공식 HSP MCP는 IP 허용 목록 방식이고 QA는 테스트넷만 열려 있다(인도 팀 기준). 서울 경쟁작 다수가 아직 허용 대기 중이다. 다들 결국 붙일 것이므로 "진짜 HSP"는 기본 조건이지 차별점이 아니다.
4. 모두 **자기 앱 안에 결제 흐름을 박아 넣었다.** 다른 에이전트가 가져다 쓰는 지갑 제품은 없다.

### 2.3 차별점 (최종)

| # | 차별점 | 경쟁작 대비 |
|---|---|---|
| D1 | **HSP 공식 MCP의 서명자(Signer)로 붙는 지갑 제품**: `npx` 한 줄 설치, Claude Desktop·Cursor·GPT 어디에든 MCP로 연결 | 경쟁작은 자기 앱 전용 흐름. 우리는 생태계 부품 → 공식 제품 가산점 + "생태계 가치" |
| D2 | **사람 클릭 없는 자율 결제**: 사람은 정책을 한 번만 정하고, 결제마다 지갑이 사람 대신 clear-signing 검증 | leash·Tandem은 결제마다 사람 승인 |
| D3 | **키 격리**: 서명 키는 별도 서명 프로세스에만 있고, 에이전트가 보는 MCP 서버에는 키가 없다. "검증 통과 티켓" 없이는 서명 프로세스가 아무것도 서명하지 않는다 | 경쟁작은 에이전트 프로세스가 키를 같이 쥔다 |
| D4 | **실제 LLM 레드팀 수치**: Claude·GPT 에이전트에 인젝션 시나리오를 돌려 "지갑 없을 때 N건 결제됨 → 지갑 있을 때 0건, 정상 결제 오탐 0건" | 실제 LLM이 속는 장면을 잰 곳이 없다 |
| D5 | **에이전트가 읽을 수 있는 거부**: 거부 코드와 다음 행동(예: "판매자에게 주문 재발급 요청")을 구조화해서 돌려줘, 에이전트가 스스로 복구한다 | 경쟁작 거부는 사람용 문구 |
| D6 | **증거 체인 (Ouryn 유산)**: 의도 → 주문(get_order 재조회) → 서명 바이트 → HSP 상태 → 체인 Transfer까지 해시로 묶어 HSK 메인넷에 기록 | 영수증은 흔하다. 서명 바이트까지 묶는 건 Ouryn `EVMEvidence` 방식 |

### 2.4 팀 출품작과의 경계 (겹치지 않게)

팀 작품은 부산 기획안 방식(폐기 우회 공격 측정, 체결 시점 체인 Guard, 책임 판정)으로 같은 트랙에 낸다.

| | Countersign (이 프로젝트) | 팀 출품작 |
|---|---|---|
| 위협 | **키는 안전한데 에이전트가 속았을 때** (인젝션, 조작된 주문) | **키가 털렸을 때** (폐기 우회, 공격 창) |
| 막는 곳 | 서명 전, 지갑 안 | 체결 시점, 체인 위 |
| 한도 | 오프체인 건당·일일 상한 + 허용 상대 **정도만**. 발표에서 강조하지 않는다 | 온체인 누적 한도, 위임 사슬 |
| 다루지 않는 것 | 폐기(revoke) 장면, 온체인 누적 한도, 위임 사슬, 책임 판정 | 지갑 UX, MCP 연결, 서명 검증 |
| 한 줄 | "에이전트가 속아도 지갑은 안 속는다" | "털린 키는 체인이 막는다" |

---

## 3. MVP 범위

### 한다
- [ ] TS 지갑 코어: 니모닉/HD 파생(`m/44'/60'/0'/0/n`, Ouryn과 같은 경로), 에이전트별 계정 분리
- [ ] **서명 프로세스 분리** (`signer`): 키는 여기에만. 로컬 소켓으로 "검증 티켓 + typed data"만 받는다
- [ ] 정책 엔진(최소): 건당 상한, 일일 상한, 허용 판매자(`pay_to`) 목록, 허용 토큰/체인, 만료
- [ ] Evidence 검증기: `prepare_payment` 결과의 EIP-712를 디코드해 `get_order`로 재조회한 주문·정책과 필드별 대조, 서명 후 서명자 복원
- [ ] HSP 공식 MCP 클라이언트 (8개 도구, §4.1) + 문서 형태를 따른 로컬 목(mock)
- [x] 지갑 MCP 서버 (§5.3): 구매 도구 4개 (11/24). 판매 쪽은 MCP 도구 대신 판매 서버가 HSP를 직접 부른다 (`apps/seller`)
- [ ] 데모 에이전트: 구매 에이전트(실제 LLM) — Claude Code `claude -p`로 정상·인젝션 1회씩 확인(11/24), 레드팀 수치는 아직 / [x] 정상 판매 서버, 악성 판매 서버 4종 (11/24)
- [ ] 레드팀 하니스: 공격 시나리오 × LLM 2종 × (지갑 없음/있음), 정상 시나리오 오탐 확인
- [ ] `EvidenceRegistry` 컨트랙트: HSK 메인넷 배포 + 블록스카우트 검증
- [ ] Evidence 뷰어 (웹 한 페이지, 읽기 전용): 결제별 3칸 대조 카드(에이전트 요청 / 주문 / 서명 바이트)와 탐색기 링크
- [ ] README: 심사 6개 항목 자가 점검 표, 주장별 VERIFIED / REPRODUCIBLE / NOT-CLAIMED 표

### 안 한다 (시간 남으면 제안만)
- 폐기(revoke) 시연, 온체인 누적 한도, 위임 사슬 (팀 작품 몫)
- Merchant REST 직접 연동 (판매자 자격 증명이 나오면 그때 보조 레일로)
- USDT/Permit2, 스마트 계정, 토큰 스왑, iOS 앱 연동 (iOS는 발표의 "다음 단계"로만)

---

## 4. HSP에서 확인된 사실

### 4.1 공식 HSP Agentic Payment MCP 서버 (핵심 경로)

출처: 공개 경쟁작 README(hsk-meter, leash)의 기록. **HSP 가이드 원문으로 다시 확인할 것 (§9 #1).**

- 주소(QA): `https://mcp-qa.hashkeymerchant.com/` · **IP 허용 목록 방식** · 2026-10-30 해커톤 팀에 공개
- 도구 8개: `get_chain_config`, `create_order`, `get_order`, `prepare_payment`, `finalize_payment`, `estimate_fee`, `submit_payment`, `query_payment`
- 흐름: 판매 측 `create_order` → 구매 측 `get_order`, `prepare_payment`(EIP-712 데이터와 payment payload 반환) → **지갑이 EIP-3009 `TransferWithAuthorization` 서명** → `finalize_payment` → `submit_payment` → HSP relayer가 브로드캐스트(구매자는 가스 불필요) → `query_payment` 폴링
- 상태: `payment-safe`(확인 절반)와 `payment-finalized`를 구분해서 보여 준다. 15~40분 뒤에는 `query_payment`가 오류를 돌려줄 수 있다
- 오류 30043: 이전 서명의 `validBefore`가 지나기 전에는 새로 서명하지 않는다. 이전 서명은 재제출하지 않는다
- 인도 대회 시점 QA가 지원한 네트워크: Base Sepolia, Ethereum Sepolia, Arbitrum Sepolia. HSK 테스트넷(133)은 목록에 있지만 테스트 USDC를 공개적으로 받을 방법이 없었다. **HSK 메인넷 HSP 결제는 열려 있지 않았다**

### 4.2 Merchant REST API (보조, 자격 증명 나오면)

출처: HashKey Merchant API 문서 (`github.com/hashkey-merchant/hashkey-merchant.github.io`)

- Cart Mandate(판매자 결제 요청, `merchant_authorization` ES256K JWT) / Payment Mandate(구매자 EIP-712 서명). Google AP2 개념
- 판매자 `POST /api/v1/merchant/orders`(일회성), `/orders/reusable`(재사용) → `flow_id` → 구매자 `POST /api/v1/payment/pay-mandate`
- 인증: HMAC-SHA256 (`X-App-Key`, `X-Signature`, `X-Timestamp`, `X-Nonce`), 본문 해시는 Canonical JSON
- 엔드포인트: QA `merchant-qa.hashkeymerchant.com` / Staging(메인넷) `merchant-stg.hashkeymerchant.com` / 운영 `hsp.hashkey.com`
- 판매자 등록은 운영진 초대 필요(secp256k1 공개키 제출). 공식 SDK 저장소: `github.com/hashkey-merchant/sdks`

### 4.3 HSK Chain 토큰과 네트워크

| 네트워크 | Chain ID | 토큰 | 주소 | decimals | 방식 |
|---|---|---|---|---|---|
| hashkey (메인넷) | 177 | USDC | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` | 6 | EIP-3009 |
| hashkey (메인넷) | 177 | USDT | `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029` | 6 | Permit2 |
| hashkey-testnet | 133 | USDC | `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` | 6 | EIP-3009 |
| hashkey-testnet | 133 | USDT | `0x372325443233fEbaC1F6998aC750276468c83CC6` | 6 | Permit2 |

| | 메인넷 | 테스트넷 |
|---|---|---|
| Chain ID | 177 | 133 |
| RPC | `https://mainnet.hsk.xyz` | `https://testnet.hsk.xyz` |
| 탐색기 | `https://hsk.blockscout.com` | `https://testnet-explorer.hskchain.net` |
| Faucet | — | `https://faucet.hskchain.net/faucet` (브라우저 reCAPTCHA, 하루 1회) |
| 가스 토큰 | HSK (18 decimals) | HSK |

### 4.4 우리 지갑 주소 (공개값, 비밀 아님)

| 키체인 이름 | 주소 | 용도 |
|---|---|---|
| `OURYN_DEV_MNEMONIC` (0번 계정) | `0x0BcBbA445d135d64611AE553d4BFa04E961b3ecF` | 테스트넷 개발용. 에이전트 계정은 이 니모닉의 1, 2, … 번 |
| `OURYN_DEPLOYER_KEY` | `0x6842834ddCaD485CAfDaB6043e6eFaCE725Ab114` | HSK 메인넷 배포·증거 기록. 거래소 HSK 출금 주소 |

### 4.5 심사 기준 (추정)

서울 Luma 공지: 데모 발표팀은 **완성도, 기술적 성숙도, 혁신성**으로 선정 (배점 없음). 개발 리소스로 HSP API 문서, HSP Agentic Payment Setup & Execution Guide, Chainlink CCIP Router, HashFans, 텔레그램 지원방을 안내하지만 가산점 대상 목록은 따로 없다. 참고:
- 뭄바이 데모데이: 문제, 기술, 사용자 경험, 향후 계획
- hsk-meter가 자가 점검에 쓴 6개 항목: **Track fit, Completeness, Team, Solution value, Authenticity, Code quality**. README는 이 6개 항목에 그대로 답하는 구조로 쓴다

---

## 5. 아키텍처

```
 사람(주인) ── 정책 파일 / CLI (한 번만) ─────────────────────────┐
                                                                  ▼
┌──────────────┐ MCP  ┌──────────────────────────────┐  소켓  ┌──────────────┐
│ Buyer Agent  │────▶ │ Ouryn Wallet MCP (키 없음)    │──────▶ │ Signer        │
│ Claude / GPT │◀──── │ ① get_order로 주문 재조회     │ 티켓+  │ (키는 여기만) │
└──────────────┘ 결과 │ ② 정책 검사                   │ typed  │ 티켓 검증 후  │
       ▲ A2A: 견적,   │ ③ prepare_payment → EIP-712   │ data   │ 서명만 한다   │
       │ flow 정보    │    디코드·주문과 필드별 대조  │◀────── │              │
┌──────────────┐      │ ④ 서명자 복원 확인            │ 서명   └──────────────┘
│ Seller Agent │─MCP─▶│ ⑤ finalize·submit·query 폴링  │
│ (정상/악성)  │      │ ⑥ 체인 Transfer 대조          │
└──────────────┘      └───────────────┬──────────────┘
                                      │ HSP 공식 MCP (8개 도구)
                          ┌───────────▼───────────┐
                          │ HSP Gateway / Relayer  │──▶ 결제 체인
                          └───────────────────────┘
                                      │ 증거 해시
                          EvidenceRegistry (HSK 메인넷 177)
```

### 5.1 결제 한 번의 순서

1. Seller가 지갑 MCP `request_payment`로 HSP `create_order` → 주문 정보를 Buyer에게 전달 (A2A 메시지)
2. Buyer(LLM)가 지갑 MCP `pay({order_ref, intent})` 호출. intent 예: `{ purpose: "주소 프로필 1건", max_amount: "0.10", seller: "profile-seller" }`
3. 지갑이 **HSP `get_order`로 주문을 직접 다시 가져온다** (Buyer가 준 값을 믿지 않음)
4. 검사: 체인·토큰이 허용 목록, `pay_to`가 그 판매자의 고정 주소, `amount ≤ intent.max_amount`, `amount ≤ 건당/일일 남은 한도`, 만료 전, 같은 주문 중복 결제 아님
5. `prepare_payment` → EIP-712 디코드 → **4번 값과 필드별 대조**(`to`, `value`, `chainId`, `verifyingContract`, `validBefore`, `from`=이 에이전트 계정). 통과하면 해시가 담긴 1회용 검증 티켓 발급
6. Signer가 티켓과 typed data 해시가 같은지 확인한 뒤 서명 → 지갑이 `recoverTypedDataAddress`로 서명자 확인
7. `finalize_payment` → `submit_payment` → `query_payment` 폴링 → 체인에서 Transfer 1건이 주문과 같은지 확인
8. `EvidenceRegistry.record(...)` 기록, 일일 사용량 갱신
9. 어느 단계든 실패 → `{ok:false, code, step, reason, next_action}` 반환, 서명 안 함

### 5.2 Ouryn → TS 재구축 매핑

| Ouryn (Swift) | 하던 일 | TS 모듈 |
|---|---|---|
| `Keys.swift` `path()` / `signingKey()` | HD 경로, 계정 슬롯(`m/44'/60'/0'/0/n`) | `wallet-core/keys.ts` (viem `mnemonicToAccount`, `addressIndex`) |
| `EVMTransfer.quote()` | 견적, 45초 만료 | `wallet-core/quote.ts` (HSP 주문 → 내부 Quote, 만료 포함) |
| `EVMEvidence.parse/matches` | 서명된 바이트 재파싱 → 견적과 대조 | `wallet-core/evidence.ts` (EIP-712 디코드·대조 + 서명자 복원 + 증거 해시) |
| `EVMTransfer.broadcast` | 응답 해시가 내 해시와 같은지 확인 | `hsp/payer.ts` (제출 후 flow·tx 일치 확인) |
| `EVMTransfer.status` | receipt 폴링 | `hsp/payer.ts` `waitFinal()` |
| `PinVault` / 생체 인증 | 사람 확인 게이트 | `signer/` (검증 티켓 게이트) + `wallet-core/policy.ts` |
| `Tests/check_*.swift` | 체인별 자가 검증 | `*.test.ts` — **같은 니모닉에서 Ouryn과 같은 주소가 나오는지** 테스트 |

> 메모: EVM만 다루므로 WalletCore WASM 대신 **viem**으로 충분하다.

### 5.3 지갑 MCP 도구 (에이전트가 보는 인터페이스)

11/24 구현 (`apps/wallet-mcp`, stdio). 처음 설계의 `wallet_info`·`inspect_order`·판매 도구 대신 아래 4개로 정했다.
판매 쪽은 키가 필요 없어서 MCP 도구 없이 판매 서버(`apps/seller`)가 HSP를 직접 부른다.

| 도구 | 입력 | 출력 |
|---|---|---|
| `pay_order` | `order_ref`, `intent{purpose, max_amount, seller}` | 성공: `payment_id`, `hsp_status`, `tx_hash`, 금액·수취인·체인, 증거 해시, `next_action`(판매자에게 납품 요청) / 실패: `code`, `step`, `reason`, `next_action` (MCP `isError`) |
| `get_balance` | — | 허용 체인별 USDC 잔액(RPC 읽기), 남은 24시간 한도 |
| `get_policy` | — | 허용 판매자·주소, 체인, 건당·일일 한도, 24시간 사용액, 정지 여부 (읽기 전용) |
| `get_history` | `limit` | 최근 승인·거부·실패 내역 |

주인(사람)용 기능(정책·내역 보기, 정지·재개)은 MCP가 아니라 별도 로컬 HTTP **주인 API**(`apps/owner-api`, PWA 앱용)로 연다. 정지는 토큰 없이, 재개는 주인 토큰이 있어야 한다. 정지 스위치는 지갑 MCP와 **signer가 둘 다** 서명할 때마다 다시 읽는다.

정책 변경, 키 내보내기, 임의 서명(`sign_raw`)은 **MCP에 열지 않는다.** 에이전트가 자기 한도를 올리거나 키를 빼낼 방법이 없어야 한다.

### 5.4 거부 코드 (D5)

| code | 뜻 | next_action |
|---|---|---|
| `PAYEE_MISMATCH` | `pay_to`가 그 판매자의 고정 주소가 아님 | 판매자에게 주문 재발급 요청, 반복되면 거래 중단 |
| `AMOUNT_OVER_INTENT` | 주문 금액 > 에이전트가 밝힌 최대 금액 | 견적 재확인 |
| `OVER_LIMIT` | 건당·일일 상한 초과 | 사람에게 보고 |
| `TYPED_DATA_MISMATCH` | `prepare_payment`의 서명 대상이 주문과 다름 | 결제 중단, 사람에게 보고 |
| `CHAIN_OR_TOKEN_NOT_ALLOWED` | 허용 안 된 체인·토큰 | 다른 결제 수단 요청 |
| `EXPIRED` / `DUPLICATE` | 만료 / 이미 결제한 주문 | 새 주문 요청 / 중단 |
| `SIGNATURE_INVALID` | 서명 후 복원한 서명자가 에이전트 계정이 아님 | 결제 중단, 사람에게 보고 (11/24 추가) |
| `TICKET_INVALID` | signer에 검증 티켓 없이/위조·만료·재사용 티켓으로 요청 | 지갑 `pay`로 처음부터 다시 (11/24 추가) |
| `INVALID_INPUT` | intent 등 입력 형식 오류 | 형식 고쳐 재호출 (11/24 추가) |
| `PAUSED` | 주인이 결제를 정지함 | 결제하지 말고 주인에게 알림 (11/24 추가) |
| `HSP_ERROR` | HSP 호출 실패·없는 주문·응답 형식 다름 | 잠시 후 재시도, 계속되면 새 주문 요청 (11/24 추가) |
| `SIGNER_UNAVAILABLE` | signer 프로세스가 꺼져 있음 | 주인에게 signer 실행 요청 (11/24 추가) |

### 5.5 정책 파일 (최소)

```json
{
  "agent": "buyer-1",
  "accountIndex": 1,
  "chains": [84532],
  "token": "USDC",
  "perTxMax": "0.50",
  "dailyMax": "5.00",
  "sellers": { "profile-seller": "0x..." }
}
```

---

## 6. 스마트 컨트랙트 (메인넷 필수)

`EvidenceRegistry.sol` — 작게 유지한다. **폐기·한도 로직은 넣지 않는다**(팀 작품 영역).

- `registerAgent(address agent, bytes32 policyHash)` — 주인이 에이전트 계정과 정책 해시를 등록
- ~~`record(bytes32 orderHash, bytes32 typedDataHash, address payTo, uint256 amount, uint256 payChainId, bytes32 payTxHash)` — 등록된 에이전트 계정만 호출~~
- **변경(11/24, Claude)**: `record(bytes32 orderHash, Authorization a, bytes signature, bytes32 payTxHash)` — **주인(owner)만 호출**하고, 컨트랙트가 EIP-3009 typed data digest를 체인 위에서 다시 계산해 `ecrecover == a.from`(등록된 에이전트)인지 확인한다.
  - 이유 1: 에이전트 계정이 직접 tx를 보내려면 signer가 "임의 tx 서명"을 해야 해서 키 격리(D3) 원칙과 충돌한다.
  - 이유 2: payTo·amount·token·payChainId가 에이전트 서명으로 묶여서, 기록하는 쪽이 값을 바꿔 적을 수 없다 (서명 바이트까지 묶는 D6이 체인 위에서 검증됨).
  - orderHash·payTxHash는 서명에 안 묶이므로 owner만 붙인다. 같은 orderHash 중복 기록은 거부.
- 이벤트: `AgentRegistered`, `EvidenceRecorded`
- 결제가 다른 체인(HSP QA 테스트넷)에서 일어나도 증거는 HSK 메인넷에 모인다. "결제는 HSP가 연 곳 어디서든, 증거는 HSK Chain에"

도구: Foundry. 테스트넷(133) 검증 → 메인넷(177) 배포 → 블록스카우트 소스 검증. **11/26에 일찍 끝내서** 데모 탈락 위험을 없앤다.

---

## 7. 기술 스택과 저장소 구조

- TypeScript, Node 20+, pnpm workspace
- viem (키, EIP-712, RPC), `@modelcontextprotocol/sdk` (지갑 MCP 서버 + HSP MCP 클라이언트), zod, vitest
- Foundry (컨트랙트)
- 데모 에이전트 LLM: Claude와 GPT 둘 다 (레드팀 수치용)
- HSP 허용 IP용 고정 IP 서버 1대 (§9 #3)

```
countersign-agent/          (로컬 폴더: ~/Developer/Countersign)
├─ PROJECT.md              ← 이 문서
├─ AGENTS.md               ← AI 협업 규칙
├─ packages/
│  ├─ wallet-core/         keys · amount · quote · policy · evidence (+ tests)
│  ├─ signer/              키 보관 프로세스, 검증 티켓 확인 후 서명
│  └─ hsp/                 canonical · config · types · mcp-client.ts(공식 MCP 8개 도구) · mock.ts
│                          (hsp는 가장 아래층: wallet-core가 hsp를 import한다. payer·seller 흐름은 순환 의존을 피하려고 apps/wallet-mcp에 둔다)
├─ apps/
│  ├─ wallet-mcp/          지갑 MCP 서버 (stdio, 도구 4개) + 끝에서 끝 테스트
│  ├─ owner-api/           주인 API (PWA용: 정책·내역·정지/재개, 127.0.0.1:7420)
│  ├─ seller/              판매 서버 (AI 없음) + 악성 모드 4종
│  ├─ demo/                demo.sh(HSP mock·signer·판매자·주인 API 한 번에) · 스크립트 구매자 · 정책 예시
│  ├─ redteam/             공격 시나리오 하니스 + 결과 표
│  └─ web/                 Evidence 뷰어 (한 페이지, 읽기 전용)
└─ contracts/              EvidenceRegistry (Foundry)
```

---

## 8. 일정 (11/24 ~ 12/3 13:00)

| 날짜 | 할 일 | 완료 기준 |
|---|---|---|
| 11/24 (화) | **DoraHacks 등록**, **운영진에 HSP 공식 MCP IP 허용 요청**(§9 #1~3), 고정 IP 서버 준비, 메인넷 HSK 확보, 저장소 세팅, `keys.ts`, `amount.ts` | 허용 요청 발송, Ouryn과 같은 주소 테스트 통과 |
| 11/25 (수) | `policy.ts`, `evidence.ts`, 변조 테스트 (수취인·금액·체인·토큰·만료·서명자·중복) | 변조 케이스 전부 거부 |
| 11/26 (목) | `signer` 분리, HSP MCP 클라이언트 + mock, **EvidenceRegistry 테스트넷 → 메인넷 배포** | 메인넷 컨트랙트 검증 완료 |
| 11/27 (금) | HSP QA 실연동 E2E (허용 받은 경우) | **HSP 첫 실결제 tx**. 허용이 안 나왔으면 mock E2E로 대신하고 재요청 |
| 11/28 (토) | 지갑 MCP 서버(구매·판매 도구), Claude Desktop 연결, 에이전트끼리 결제 | LLM 구매 에이전트 → 판매 에이전트 결제 1회 |
| 11/29 (일) | 악성 판매 에이전트, 레드팀 하니스 (Claude·GPT × 공격 × 지갑 유무) | 결과 표 1장 |
| 11/30 (월) | 메인넷 증거 기록 연결, 거부 코드 복구 흐름, CI | 결제 → 메인넷 증거까지 한 번에 |
| 12/1 (화) | Evidence 뷰어, `npx` 설치 경로 다듬기 | 처음 보는 사람이 5분 안에 붙일 수 있음 |
| 12/2 (수) | README(6개 항목 자가 점검, 주장 표), 데모 영상, 발표 자료 | 제출물 초안 완성 |
| 12/3 (목) 오전 | 버퍼, **13:00 전 제출** | 제출 완료 |

**판단 시점**: 11/27까지 HSP 허용이 안 나오면 mock E2E로 데모를 완성하고, README에 NOT-CLAIMED로 정직하게 적는다. 운영진에 매일 재요청한다.

---

## 9. 미결 사항 (확인되면 이 표를 고친다)

| # | 질문 | 왜 중요 | 어디서 확인 |
|---|---|---|---|
| 1 | HSP 공식 Agentic Payment MCP 접근: IP 허용 신청 방법, 가이드 원문(도구 입력·출력 형식) | 핵심 경로 전체 | 운영진 / 텔레그램 |
| 2 | **서울 대회에서 HSK 메인넷(또는 HSK 테스트넷 133) HSP 결제가 열리는지**, 테스트 USDC 받는 방법 | "HSK Chain에서 HSP 결제"를 보여 줄 수 있는지 | 운영진 |
| 3 | 허용 IP: 고정 IP 서버를 어디에 둘지 (맥은 IP가 바뀐다) | 실연동 위치 | 결정: 태민 |
| 4 | "공식 권장 제품·프레임워크" 목록에 HSP MCP 말고 더 있는지 | 가산점 | 운영진 |
| 5 | ~~서울 심사 기준~~ → 완성도·기술적 성숙도·혁신성 (Luma, 배점 없음) | README·발표 구조 | 해결 |
| 6 | 메인넷 HSK 가스 확보 | 컨트랙트 배포, 증거 기록 | 거래소 출금 |
| 8 | HSP MCP 도구별 **입력 인자 이름과 응답 형태** (`get_order`의 금액이 최소 단위 정수인지 "0.10" 같은 소수인지, `prepare_payment`가 typed data를 어떤 키로 주는지, `finalize_payment`에 무엇을 넘기는지) | 지금은 `packages/hsp/src/types.ts`에 내부 표준 형태를 정해 두고 mock이 그걸 따른다. 실제 형식은 `mcp-client.ts`의 `args`·`adapt` 두 곳만 고치면 된다 | HSP 가이드 원문 |
| 9 | USDC EIP-712 domain의 `name`/`version`이 체인별로 무엇인지 (HSK 177·133, Sepolia 계열) | 틀리면 서명이 체인에서 무효가 될 뿐 돈이 새지는 않는다. 지금은 HSP가 준 값을 그대로 쓰고 검사하지 않는다 | 토큰 컨트랙트 `name()`/`version()` 조회 |
| 10 | `query_payment` 응답에 `order_ref`가 있는지, 판매자가 "이 결제가 내 주문 것"임을 어떻게 확인하는지 (지금은 구매자가 `payment_id`를 판매자에게 넘기고, 판매자가 `query_payment`의 `order_ref`로 대조한다고 가정. mock은 그렇게 동작) | 판매 서버 납품 조건 | HSP 가이드 원문 |
| 7 | ~~Merchant REST 판매자 등록이 필요한지~~ → 불필요. 공식 MCP 서버가 판매자 키를 대신 들고 EIP-712 데이터를 돌려준다 (hsk-meter `hsp_qa/README.md`) | 일 줄이기 | 해결 |

---

## 10. 제출물 체크리스트

- [x] DoraHacks 등록·해커톤 제출 (2026-11-24, BUIDL https://dorahacks.io/build/51775, Track 2). 마감 전까지 본문 갱신
- [ ] 공개 GitHub 저장소 + README: 문제, 구조, HSP 사용 위치를 파일 경로로, **Ouryn-Wallet 재구축 출처 명시**, 심사 6개 항목 자가 점검, 주장별 VERIFIED / REPRODUCIBLE / NOT-CLAIMED 표
- [ ] HSK Chain 메인넷 `EvidenceRegistry` 주소 + 블록스카우트 검증 링크
- [ ] HSP 결제 tx 링크 (정상 1건 이상) + 해당 결제의 메인넷 증거 tx
- [ ] 레드팀 결과 표 (LLM 2종, 지갑 유무, 오탐 수)
- [ ] CI 배지와 테스트 수
- [ ] 데모 영상 3분: ① Claude가 지갑으로 결제 ② 악성 판매자 인젝션에 속은 에이전트를 지갑이 거부, 에이전트가 거부 코드를 읽고 스스로 복구 ③ 레드팀 수치
- [ ] 발표 자료 (12/5 현장 발표, 다음 단계: Ouryn iOS 앱에서 정책 설정)
