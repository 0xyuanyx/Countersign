#!/usr/bin/env bash
# 사용법:
#   script/deploy.sh testnet            # 시뮬레이션만 (전송 안 함)
#   script/deploy.sh testnet --broadcast --verify
#   script/deploy.sh mainnet --broadcast --verify   # ← 태민만 실행
# 키는 맥 키체인에서 이 프로세스 환경변수로만 읽고, 화면에 출력하지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
net="${1:-}"; shift || true
kc() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null; }
unset OURYN_DEV_MNEMONIC OURYN_DEPLOYER_KEY
case "$net" in
  testnet) export OURYN_DEV_MNEMONIC="$(kc OURYN_DEV_MNEMONIC)"; rpc=hsk_testnet ;;
  mainnet) export OURYN_DEPLOYER_KEY="$(kc OURYN_DEPLOYER_KEY)"; rpc=hsk_mainnet ;;
  *) echo "testnet 또는 mainnet" >&2; exit 1 ;;
esac
[[ -n "${OURYN_DEV_MNEMONIC:-}${OURYN_DEPLOYER_KEY:-}" ]] || { echo "키체인에서 키를 못 찾음" >&2; exit 1; }
exec forge script script/Deploy.s.sol:Deploy --rpc-url "$rpc" "$@"
