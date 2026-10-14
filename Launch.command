#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [[ "$(uname -s)" != Darwin ]]; then echo 'Mac only.'; exit 1; fi
DEST="$(cd "$(dirname "$0")" && pwd)"
if [[ ! -f "$DEST/auth/siwc-sidecar.mjs" || ! -d "$DEST/node_modules" ]]; then
  echo 'First run ./setup.sh to install dependencies.'; exit 1
fi
cd "$DEST"
# npm install or the upstream Whisper setup can remove the local SDK symlink.
if [[ ! -f node_modules/@siwc/local/dist/index.js ]]; then
  if [[ ! -f .siwc-devkit/packages/local/dist/index.js ]]; then
    echo 'ChatGPT SDK is missing. Run ./scripts/setup-chatgpt-sdk.sh to set it up.'; exit 1
  fi
  mkdir -p node_modules/@siwc
  if [[ -L node_modules/@siwc/local ]]; then rm node_modules/@siwc/local; fi
  if [[ -e node_modules/@siwc/local ]]; then
    echo 'Conflicting @siwc/local installation found. Remove node_modules/@siwc/local and re-run ./scripts/setup-chatgpt-sdk.sh.'; exit 1
  fi
  ln -s "$DEST/.siwc-devkit/packages/local" node_modules/@siwc/local
fi
MODE="$(grep -E '^AI_PROVIDER=' .env | tail -n1 | cut -d= -f2- | tr -d '\r' || true)"
case "$MODE" in
  local|chatgpt) ;;
  *) echo "Invalid AI_PROVIDER '$MODE' in $DEST/.env"; exit 1;;
esac
if ! command -v node >/dev/null 2>&1; then echo 'Node.js 22.12+ is required.'; exit 1; fi
# Explicit env overrides an old Electron userData/.env from previous installs.
export AI_PROVIDER="$MODE"
export SIWC_NODE_BIN="$(node -p 'process.execPath')"
if [[ "$MODE" = local ]]; then
  url="$(grep -E '^LOCAL_LLM_URL=' .env | tail -n1 | cut -d= -f2- | tr -d '\r' || true)"
  url="${url:-http://127.0.0.1:8080/v1}"
  if ! curl -sf --connect-timeout 2 --max-time 4 "${url%/}/models" >/dev/null; then
    echo "WARNING: Local AI server not responding at ${url%/}/models"
    echo 'Start your MLX/llama.cpp server before making AI requests.'
  fi
fi
npm start
