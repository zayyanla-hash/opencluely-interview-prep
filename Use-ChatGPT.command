#!/usr/bin/env bash
set -euo pipefail
DEST="$(cd "$(dirname "$0")" && pwd)"
if [[ ! -f "$DEST/.env" ]]; then echo 'Run ./setup.sh first to create .env and install dependencies.'; exit 1; fi
APP_ENV="$DEST/.env" node - <<'NODE'
const fs=require('fs');const f=process.env.APP_ENV;let s=fs.readFileSync(f,'utf8');
s=/^AI_PROVIDER=.*$/m.test(s)?s.replace(/^AI_PROVIDER=.*$/m,'AI_PROVIDER=chatgpt'):s+'\nAI_PROVIDER=chatgpt\n';
fs.writeFileSync(f,s,{mode:0o600});fs.chmodSync(f,0o600);
NODE
echo 'Switched to ChatGPT mode. Reopen Launch.command. Use Cmd+Shift+G for the account panel.'
