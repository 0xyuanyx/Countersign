#!/usr/bin/env bash
# 로컬 데모 묶음 (HSP mock + signer + 판매 서버 정상·악성 4종 + 주인 API)
#   apps/demo/demo.sh up      # 띄우기 (signer는 키체인 OURYN_DEV_MNEMONIC의 1번 계정, 결제 체인 Ethereum Sepolia)
#   COUNTERSIGN_NET=hsk-testnet apps/demo/demo.sh up   # HSK 테스트넷(133) 설정으로
#   apps/demo/demo.sh down    # 끄기
#   apps/demo/demo.sh env     # 지갑 MCP를 붙일 때 쓸 환경변수 출력
# 돈은 움직이지 않는다 (HSP mock). 메인넷 키는 읽지 않는다.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tsx="$root/node_modules/.bin/tsx"
export COUNTERSIGN_HOME="${COUNTERSIGN_HOME:-$root/.countersign}"
case "${COUNTERSIGN_NET:-sepolia}" in
  sepolia)     default_policy="$here/policy.sepolia.json"; export COUNTERSIGN_PAY_CHAIN_ID=11155111 ;;
  hsk-testnet) default_policy="$here/policy.testnet.json"; export COUNTERSIGN_PAY_CHAIN_ID=133 ;;
  *) echo "COUNTERSIGN_NET은 sepolia 또는 hsk-testnet" >&2; exit 1 ;;
esac
export COUNTERSIGN_POLICY="${COUNTERSIGN_POLICY:-$default_policy}"
export COUNTERSIGN_HSP_MODE=mock
export COUNTERSIGN_HSP_MCP_URL="http://127.0.0.1:7410/mcp"
# 판매자 받는 주소: 개발 니모닉 901·902번 (공개 주소). 2번부터는 에이전트 계정이라 겹치지 않게 900번대를 쓴다
SELLER_PAY_TO="0x928CED58e2b79aA60ACd3Df2F3cA2037C92E1978"   # data-mart (#901)
NEWS_PAY_TO="0x36C4d4C2026C4814FEBf98759d1B97E2B201D4Bb"     # news-wire (#902, 처음 보는 판매자 데모)
logs="$COUNTERSIGN_HOME/logs"; pids="$COUNTERSIGN_HOME/demo.pids"

start() { # 이름 명령...
  local name="$1"; shift
  ("$@" >"$logs/$name.log" 2>&1 & echo "$! $name" >>"$pids")
}

wait_port() {
  for _ in $(seq 1 50); do nc -z 127.0.0.1 "$1" 2>/dev/null && return 0; sleep 0.2; done
  echo "포트 $1 이 열리지 않음 ($2 로그: $logs/$2.log)" >&2; exit 1
}

case "${1:-}" in
  up)
    mkdir -p "$logs"; chmod 700 "$COUNTERSIGN_HOME"; : >"$pids"
    start hsp-mock "$tsx" "$root/packages/hsp/src/mock-main.ts"; wait_port 7410 hsp-mock
    start signer "$tsx" "$root/packages/signer/src/main.ts"
    for _ in $(seq 1 50); do [ -S "$COUNTERSIGN_HOME/signer.sock" ] && break; sleep 0.2; done
    [ -S "$COUNTERSIGN_HOME/signer.sock" ] || { echo "signer 시작 실패: $logs/signer.log" >&2; exit 1; }
    COUNTERSIGN_SELLER_PAY_TO=$SELLER_PAY_TO COUNTERSIGN_SELLER_NAME=data-mart COUNTERSIGN_SELLER_PORT=7430 start seller "$tsx" "$root/apps/seller/src/main.ts"
    COUNTERSIGN_SELLER_PAY_TO=$NEWS_PAY_TO COUNTERSIGN_SELLER_NAME=news-wire COUNTERSIGN_SELLER_PORT=7435 start news-wire "$tsx" "$root/apps/seller/src/main.ts"
    port=7431
    for m in payee amount chain inject; do
      # 악성 판매자는 data-mart 이름을 사칭한다 (받는 주소·금액·체인은 HSP 주문에서 바꿔치기)
      COUNTERSIGN_SELLER_PAY_TO=$SELLER_PAY_TO COUNTERSIGN_SELLER_NAME=data-mart COUNTERSIGN_SELLER_PORT=$port COUNTERSIGN_SELLER_EVIL=$m \
        start "evil-$m" "$tsx" "$root/apps/seller/src/main.ts"
      port=$((port + 1))
    done
    start wallet-http "$tsx" "$root/apps/wallet-mcp/src/main-http.ts"
    start owner-api "$tsx" "$root/apps/owner-api/src/main.ts"
    for p in 7430 7431 7432 7433 7434 7435 7420 7440; do wait_port $p demo; done
    cat "$logs/signer.log"
    echo "판매자: 정상 data-mart :7430, 처음 보는 판매자 news-wire :7435, 악성(data-mart 사칭) payee :7431 · amount :7432 · chain :7433 · inject :7434"
    echo "주인 API: http://127.0.0.1:7420/api/policy   원격 지갑 MCP: http://127.0.0.1:7440/mcp/<토큰> (토큰은 POST /api/agents)"
    ;;
  down)
    if [ -f "$pids" ]; then
      while read -r pid name; do kill "$pid" 2>/dev/null && echo "끔: $name"; done <"$pids"
      # 포트가 다 비워질 때까지 기다린다 (바로 up 하면 꺼지는 중인 옛 서버에 붙는 일이 있었다)
      for _ in $(seq 1 25); do
        busy=0; for p in 7410 7420 7430 7431 7432 7433 7434 7435 7440; do nc -z 127.0.0.1 $p 2>/dev/null && busy=1; done
        [ $busy = 0 ] && break; sleep 0.2
      done
    fi
    rm -f "$pids"
    ;;
  env)
    echo "COUNTERSIGN_HOME=$COUNTERSIGN_HOME"
    echo "COUNTERSIGN_POLICY=$COUNTERSIGN_POLICY"
    echo "COUNTERSIGN_HSP_MODE=mock"
    echo "COUNTERSIGN_HSP_MCP_URL=$COUNTERSIGN_HSP_MCP_URL"
    echo "COUNTERSIGN_PAY_CHAIN_ID=$COUNTERSIGN_PAY_CHAIN_ID"
    ;;
  *) echo "사용법: $0 up|down|env" >&2; exit 1 ;;
esac
