#!/usr/bin/env bash
# usage: OC=<openclaw 10.9 bin dir> FIX=realistic|flood W=<workdir> bash make-fixture.sh
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd); R=$W/fix-${FIXNAME:-$FIX}; GPORT=${GPORT:-19811}; MPORT=${MPORT:-19870}
rm -rf "$R"; mkdir -p "$R/state/workspace" "$R/home"
printf '# Memory\n' > "$R/state/workspace/MEMORY.md"
cat > "$R/state/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback", "port": $GPORT, "auth": { "mode": "token", "token": "repro-token-00000000000000000000000000" } },
  "agents": { "defaults": { "workspace": "$R/state/workspace", "model": { "primary": "fixture/fixture" } } },
  "models": { "providers": { "fixture": { "baseUrl": "http://127.0.0.1:$MPORT/v1", "api": "openai-completions", "apiKey": "local-model-fixture",
     "models": [{ "id": "fixture", "name": "fixture", "contextWindow": 1048576, "maxTokens": 131072 }] } } },
  "tools": { "exec": { "mode": "full" } },
  "channels": {}
}
JSON
t0=$(date +%s)
node "$D/seed.cjs" "$FIX" "$R/state" "$R/state/workspace"
echo "seeded in $(( $(date +%s)-t0 ))s"; du -sh "$R/state/agents/main/sessions"
. "$D/env.sh" "$R"; export PATH=$OC:$PATH
t0=$(date +%s)
openclaw doctor --session-sqlite import --session-sqlite-all-agents > "$R/import.log" 2>&1; rc=$?
echo "import rc=$rc in $(( $(date +%s)-t0 ))s"; tail -5 "$R/import.log"
du -sh "$R/state/agents/main/agent" 2>/dev/null; ls -la "$R/state/agents/main/agent" | head
