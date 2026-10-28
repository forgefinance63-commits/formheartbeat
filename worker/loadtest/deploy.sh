#!/bin/bash
# usage: deploy.sh N [main]
N=$1; MAIN=${2:-src/entry.js}
KEYS=$(python3 -c "import json;print(json.dumps(json.dumps({f'k{a:02d}':f'lt{a:02d}' for a in range(1,$N+1)})))")
cat > wrangler.toml <<T
name = "formheartbeat-loadtest"
main = "$MAIN"
compatibility_date = "2026-10-01"
workers_dev = true
[triggers]
crons = ["* * * * *"]
[observability]
enabled = true
[vars]
ALERTS_ENABLED = "false"
API_KEYS = $KEYS
LT_KEY = "$(cat ltkey)"
[[kv_namespaces]]
binding = "KV"
id = "$(cat kvid)"
[[services]]
binding = "RUNNER"
service = "formheartbeat-loadtest"
entrypoint = "Runner"
T
./node_modules/.bin/wrangler deploy 2>&1 | grep -E "Version ID|rror"
