#!/usr/bin/env bash
# 맥의 주인 API(127.0.0.1:7420)를 HTTPS로 밖에 연다. Vercel에 올린 주인 앱이 이 주소를 부른다.
#
#   apps/demo/tunnel.sh setup wallet.example.com   # 처음 한 번: 고정 주소(이름 붙인 터널) 만들기. Cloudflare에 도메인이 있어야 함
#   apps/demo/tunnel.sh run                        # 고정 주소로 열기 (주소가 안 바뀌어서 폰을 다시 짝지을 필요 없음)
#   apps/demo/tunnel.sh quick                      # 도메인 없이 임시 주소(https://….trycloudflare.com). 켤 때마다 바뀜 → 매번 다시 짝짓기
#   apps/demo/tunnel.sh url                        # 고정 주소 출력
#
# 도메인이 없을 때의 고정 주소: ngrok 무료 계정의 고정 주소 하나(https://<이름>.ngrok-free.app 등)
#   ngrok config add-authtoken <토큰>                       # 처음 한 번 (토큰은 ngrok 설정 파일에만, 저장소엔 안 넣음)
#   apps/demo/tunnel.sh ngrok-setup https://<이름>.ngrok-free.app   # 처음 한 번: 주소 기억
#   apps/demo/tunnel.sh ngrok                      # 그 고정 주소로 열기
# ngrok 무료 주소는 브라우저에 경고 페이지를 끼워 넣는데, 앱이 ngrok-skip-browser-warning 헤더를 붙여 건너뛴다.
#
# 터널 설정·인증서는 ~/.cloudflared/ 에만 둔다 (저장소에 넣지 않는다).
# 밖에 열 때 주인 API는 공개 모드로 띄운다: 모든 요청에 주인 토큰, CORS는 Vercel 앱 주소만.
#   COUNTERSIGN_APP_ORIGIN=https://<앱>.vercel.app COUNTERSIGN_OWNER_API_PUBLIC=1 apps/demo/demo.sh up
# 원격 지갑 MCP(127.0.0.1:7440 /mcp/<연결 토큰>)도 같은 주소로 열려면 COUNTERSIGN_TUNNEL_MCP=1 로 setup.
set -euo pipefail
NAME="${COUNTERSIGN_TUNNEL_NAME:-countersign}"
CFG="$HOME/.cloudflared/$NAME.yml"
HOSTFILE="$HOME/.cloudflared/$NAME.hostname"
NGROKFILE="$HOME/.config/countersign/ngrok.url"
OWNER_API="http://127.0.0.1:${COUNTERSIGN_OWNER_API_PORT:-7420}"
WALLET_MCP="http://127.0.0.1:${COUNTERSIGN_WALLET_HTTP_PORT:-7440}"

need() { command -v "$1" >/dev/null || { echo "$1 이(가) 없음: $2" >&2; exit 1; }; }
case "${1:-}" in ngrok*) need ngrok "brew install --cask ngrok" ;; *) need cloudflared "brew install cloudflared" ;; esac

case "${1:-}" in
  setup)
    host="${2:-}"
    [[ "$host" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "사용법: $0 setup <호스트 이름, 예: wallet.example.com>" >&2; exit 1; }
    mkdir -p "$HOME/.cloudflared"
    # 브라우저가 열리면 Cloudflare에 로그인하고 도메인을 고른다 (인증서는 ~/.cloudflared/cert.pem)
    [ -f "$HOME/.cloudflared/cert.pem" ] || cloudflared tunnel login
    cloudflared tunnel info "$NAME" >/dev/null 2>&1 || cloudflared tunnel create "$NAME"
    id="$(cloudflared tunnel info "$NAME" 2>/dev/null | awk '/^ID:/ {print $2}')"
    [ -n "$id" ] || id="$(cloudflared tunnel list 2>/dev/null | awk -v n="$NAME" '$2 == n {print $1}')"
    [ -n "$id" ] || { echo "터널 id를 찾지 못함: cloudflared tunnel list" >&2; exit 1; }
    cloudflared tunnel route dns --overwrite-dns "$NAME" "$host"
    {
      echo "tunnel: $id"
      echo "credentials-file: $HOME/.cloudflared/$id.json"
      echo "ingress:"
      echo "  - hostname: $host"
      echo "    path: ^/api/"
      echo "    service: $OWNER_API"
      if [ "${COUNTERSIGN_TUNNEL_MCP:-}" = "1" ]; then
        echo "  - hostname: $host"
        echo "    path: ^/mcp/"
        echo "    service: $WALLET_MCP"
      fi
      echo "  - service: http_status:404"
    } >"$CFG"
    echo "$host" >"$HOSTFILE"
    chmod 600 "$CFG"
    echo "고정 주소: https://$host  (설정 $CFG)"
    echo "열기: $0 run"
    ;;
  run)
    [ -f "$CFG" ] || { echo "고정 터널이 아직 없음: $0 setup <호스트 이름>  (도메인이 없으면 $0 quick)" >&2; exit 1; }
    cloudflared tunnel ingress validate --config "$CFG" >/dev/null
    echo "주인 API: https://$(cat "$HOSTFILE")/api/ → $OWNER_API"
    exec cloudflared tunnel --no-autoupdate --config "$CFG" run "$NAME"
    ;;
  quick)
    echo "임시 주소는 아래 로그의 https://….trycloudflare.com 이다. 끄면 사라지고, 다시 켜면 바뀐다."
    exec cloudflared tunnel --no-autoupdate --url "$OWNER_API"
    ;;
  ngrok-setup)
    u="${2:-}"; u="${u%/}"
    [[ "$u" =~ ^https://[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "사용법: $0 ngrok-setup https://<이름>.ngrok-free.app (ngrok 대시보드 Domains의 주소)" >&2; exit 1; }
    mkdir -p "$(dirname "$NGROKFILE")"; echo "$u" >"$NGROKFILE"
    echo "고정 주소: $u   열기: $0 ngrok"
    ;;
  ngrok)
    [ -f "$NGROKFILE" ] || { echo "ngrok 주소가 아직 없음: $0 ngrok-setup https://<이름>.ngrok-free.app" >&2; exit 1; }
    echo "주인 API: $(cat "$NGROKFILE")/api/ → $OWNER_API"
    exec ngrok http "$OWNER_API" --url "$(cat "$NGROKFILE")" --log stdout --log-level warn
    ;;
  url)
    if [ -f "$HOSTFILE" ]; then echo "https://$(cat "$HOSTFILE")"
    elif [ -f "$NGROKFILE" ]; then cat "$NGROKFILE"
    else echo "고정 터널이 아직 없음" >&2; exit 1; fi
    ;;
  *) echo "사용법: $0 setup <호스트 이름> | run | quick | ngrok-setup <주소> | ngrok | url" >&2; exit 1 ;;
esac
