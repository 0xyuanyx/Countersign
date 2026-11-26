# 주인 앱 (폰 PWA)

사람(주인)이 폰에서 에이전트 결제를 지켜보고, 처음 보는 판매자 결제를 승인하고, 긴급 정지하는 앱. 화면 기준은 `design/README.md`의 "2026-11-25 검토 반영 (구현 기준)".
프레임워크 없이 Vite + TypeScript. 폰에는 키가 없다. 앱은 주인 API(`apps/owner-api`)의 리모컨이다.

## 실행

```bash
pnpm install                                   # 처음 한 번 (jsqr, qrcode, vite)

# 1) 데모 데이터로 화면만 보기 (지갑 서버 없이)
pnpm --filter @countersign/owner-app dev:mock  # http://localhost:5173

# 2) 실제 주인 API에 붙이기
COUNTERSIGN_POLICY=apps/demo/policy.testnet.json node_modules/.bin/tsx apps/owner-api/src/main.ts   # 127.0.0.1:7420
pnpm --filter @countersign/owner-app dev       # 0.0.0.0:5173, /api는 7420으로 넘김
pnpm --filter @countersign/owner-app pair      # 터미널에 매칭 QR
```

- 폰은 127.0.0.1에만 열린 주인 API에 직접 못 붙는다. 그래서 Vite가 `/api`를 주인 API로 넘긴다 (`vite.config.ts`, 주소는 `COUNTERSIGN_OWNER_API`). 폰 → 앱 주소 → `/api` → 주인 API.
- 같은 와이파이면 `http://<맥 IP>:5173`으로 충분하다. **Face ID(패스키)와 카메라는 HTTPS에서만** 되므로 시연은 아래 Vercel 배포를 쓴다.

## Vercel 배포 (고정 주소)

앱은 Vercel 고정 주소에서, 지갑 데이터는 맥의 주인 API에서 온다. Vercel에는 프록시가 없으므로 앱은 매칭 QR에 든 주인 API 주소(`api=`)로 직접 부른다.

```
폰 (https://countersign-wallet.vercel.app) ──HTTPS·CORS──▶ 맥 터널 https://<고정 주소>/api/ ──▶ 127.0.0.1:7420 주인 API
```

- **Vercel 프로젝트**: GitHub 저장소를 가져오고 Root Directory를 `apps/owner-app`로. 나머지는 `vercel.json`(설치·빌드·헤더)이 정한다. **환경변수는 넣지 않는다** (비밀 값 없음. 데모 모드는 연결 화면 "지갑 없이 데모로 둘러보기"로 Vercel만으로 동작). 배포본은 맥 고정 터널 주소를 기본 주인 API로 갖고 있어서(`src/auth.ts`의 `DEFAULT_OWNER_API`) 매칭 QR에는 토큰만 들어간다. 다른 주소를 쓰려면 Vercel에 `VITE_OWNER_API_URL`(공개 값)을 넣거나 `pair`에 `COUNTERSIGN_OWNER_API_URL`을 주면 QR에 `api=`로 들어간다.
- **맥 쪽**: 고정 주소는 ngrok 무료 고정 주소(`https://gone-headscarf-unsoiled.ngrok-free.dev`, 처음 한 번 `ngrok config add-authtoken`과 `tunnel.sh ngrok-setup <주소>`). Cloudflare 도메인이 생기면 `tunnel.sh setup <호스트 이름>` / `run`으로 바꿀 수 있다. 저장소 폴더에서 세 줄을 차례로 (2번은 켜 둔 채로 새 탭에서 3번):

```bash
COUNTERSIGN_APP_ORIGIN=https://countersign-wallet.vercel.app COUNTERSIGN_OWNER_API_PUBLIC=1 apps/demo/demo.sh up
apps/demo/tunnel.sh ngrok
# demo.sh는 지갑 데이터를 저장소 .countersign/에 두므로 매칭도 같은 곳의 주인 토큰을 읽게 한다
# QR에는 토큰만 (터널 주소는 앱에 들어 있음). 주소가 다른 터널이면 COUNTERSIGN_OWNER_API_URL=$(apps/demo/tunnel.sh url)을 앞에 붙인다
COUNTERSIGN_HOME=$PWD/.countersign COUNTERSIGN_APP_URL=https://countersign-wallet.vercel.app pnpm --filter @countersign/owner-app pair
```

- 주인 API는 **공개 모드**(`COUNTERSIGN_OWNER_API_PUBLIC=1`)로 띄운다: 읽기·긴급 정지까지 모든 요청에 주인 토큰, CORS는 Vercel 주소만. 앱은 모든 요청에 토큰을 붙인다.
- 터널 주소가 고정이면 맥을 껐다 켜도 폰을 다시 매칭할 필요가 없다. 임시 주소(`quick`)는 켤 때마다 바뀌어 다시 매칭해야 한다.
- 패스키는 Vercel 도메인(`<앱>.vercel.app`)에 묶인다. 주소를 바꾸면 Face ID를 다시 켜야 한다 (앱 비밀번호·매칭도 브라우저 저장소가 주소별이라 다시).
- 연결 화면 맨 아래 "지갑 없이 데모로 둘러보기"는 빈 지갑에서 시작한다: 에이전트 연결 → 기본 규칙 → 입금(몇 초 뒤 26.10 USDC가 들어온 것처럼) → 일을 맡기면 첫 일은 처음 보는 판매자 구매 요청, 다음 일은 바꿔치기 주소를 막고 진짜 주소로 다시 결제. 데모 값은 메모리에만 있어서 앱을 다시 열면 처음부터. 미리 채운 샘플 내역으로 보려면 주소에 `?sample`.

## 매칭 (가입 없음)

QR = `<앱 주소>/#pair=<주인 토큰>[&api=<주인 API 주소>]`. 토큰은 `#` 뒤라 서버로 전송되지 않고, 앱이 읽자마자 주소창에서 지운다.
앱은 `GET /api/policy`로 서버에 닿는지(공개 모드면 여기서 401 = 토큰 틀림), 없는 요청을 거절해 보는 걸로(401이면 틀림, 404면 맞음) 토큰이 맞는지 확인한다. `api=`가 빠진 코드를 Vercel 앱에 넣으면 "지갑 서버 주소가 없어요"로 막는다.
아이폰은 Safari와 홈 화면 앱의 저장소가 따로라, 브라우저로 열면 먼저 홈 화면 추가 안내를 보여 주고 매칭은 홈 화면 앱 안에서 한다 (앱 안 카메라는 BarcodeDetector, 없으면 jsQR).

## 화면 (이번 버전)

| 화면 | 상태 |
|---|---|
| 스플래시 (11/25 로고 영상 `public/splash/` → 다음 화면, 영상을 못 틀면 코드 애니메이션) | 됨 |
| 홈 화면 추가 안내 (아이폰/안드로이드, 안드로이드는 설치 버튼) | 됨 |
| 연결 (QR 찍기 / 연결 코드 / 데모) | 됨 |
| 비밀번호 만들기 → 확인 → Face ID 켜기 | 됨 |
| 잠금 (앱 열 때, 5분 넘게 나갔다 오면, 결제 승인·정책 변경·정지 해제·연결 끊기 때) — 제목을 부른 화면이 넘김 | 됨 |
| 홈 (상태·잔액·오늘 한도·입금·긴급 정지·구매 요청·방금 막은 결제·최근 결제·맡길 일) | 됨 |
| 구매 요청 → 비밀번호 → "다음부터 이곳은 요청 없이 바로 결제할까요?" / 거절 / 시간 초과 | 됨 |
| 거절 상세 (6칸 띠 한 칸씩, 두 주소 비교, 다시 결제한 결과로 이어짐, 기록 접힘) | 됨 |
| 결제 상세 (승인) | 간단히 (띠·거래 링크) |
| 내역 (맡긴 일 단위, 접기, 거절 행만 띠) | 됨 |
| 정책 (한도 시트 → 저장 → 비밀번호, 판매자 보기, 체인은 서버 정책 그대로, HSK 메인넷 줄은 "수상 후"로 비활성) · 설정 (Face ID·알림 켜기·다시 매칭) | 됨 |
| 홈 상태 줄 (서버 끊김 > 잔액이 1회 한도보다 적음 > 에이전트 꺼짐, 가장 급한 것 하나) · 빈 내역 문구 | 됨 |
| 알림 (구매 요청 → 비밀번호 → 구매 요청 시트, 막은 결제 → 거절 상세) | 앱이 살아 있을 때만. 아래 한계 참고 |
| 맡길 일 (글 + 최대 금액 → `POST /api/tasks`) | 시트 하나로. 진행 단계 카드(Working)는 아직 |
| 입금 | QR · 주소 복사 · 공유(Web Share, 주소와 QR 그림) |
| 에이전트 연결·편집 (Connect, AgentEdit) | 목록 시트만 |

새로고침은 화면이 보일 때 3초마다 (뭔가 누른 직후엔 1초마다 몇 번). 서버에 못 닿으면 배너를 띄우고 계속 다시 시도한다.

## 주장 구분 (AGENTS.md 규칙 8)

| 주장 | 표시 |
|---|---|
| 앱은 키를 갖지 않는다. 서명은 signer만 한다 | VERIFIED (앱 코드에 키·서명 없음) |
| 정책 변경·정지 해제·구매 승인은 주인 토큰이 있어야 서버가 받는다 | VERIFIED (`apps/owner-api` 테스트) |
| 앱 비밀번호 6자리·Face ID가 정책 변경을 막는다 | **NOT-CLAIMED**. 이 폰에서만 확인하는 잠금이고 서버는 모른다. 폰이 털리면 저장된 주인 토큰으로 API를 부를 수 있다. 패스키 서명을 정책 변경 요청에 붙이는 건 다음 단계 |
| 화면의 거절은 지갑이 실제로 서명하지 않은 기록이다 | REPRODUCIBLE (주인 API 내역 그대로 그림. 데모 모드는 만든 값) |

## 알려진 한계

- "에이전트가 꺼져 있어요"는 지금은 연결된 에이전트가 하나도 없을 때로 판단한다. 맡긴 일을 실제로 가져가 실행하는 러너 상태가 API에 생기면 그걸로 바꾼다.
- 알림은 앱이 살아 있는 동안(다른 앱으로 넘어가 있어도) 새 구매 요청·막은 결제를 찾아 띄운다. 아이폰은 화면이 잠기면 앱이 멈춰서, 잠금 화면에 알림이 오려면 주인 API가 Web Push(VAPID)로 보내 줘야 한다. 서버 쪽 작업이 남아 있다.
- 글꼴은 Pretendard(jsDelivr)와 JetBrains Mono(Google Fonts)를 네트워크에서 받는다. 못 받으면 시스템 글꼴.
