#!/usr/bin/env python3
"""Summarize Worker cron punctuality from authenticated GET /v1/status.
Key is read from a file (default /workspace/private/worker_admin_key.txt), never printed."""
import json, os, sys, urllib.request, statistics
URL = os.environ.get("FH_URL", "https://formheartbeat.formheartbeat.workers.dev")
key = open(os.environ.get("FH_KEY_FILE", "/workspace/private/worker_admin_key.txt")).read().strip()
req = urllib.request.Request(URL + "/v1/status", headers={"authorization": "Bearer " + key, "user-agent": "fh-cron-summary"})
d = json.load(urllib.request.urlopen(req, timeout=30))
log = d.get("cron_log", [])
print("server summary:", json.dumps(d.get("cron_punctuality")))
if log:
    dl = [e["delay_ms"] for e in log]; du = [e["duration_ms"] for e in log]
    print(f"recent {len(log)} runs {log[0]['scheduled']} .. {log[-1]['scheduled']} (UTC)")
    print(f"start delay ms: median {statistics.median(dl):.0f}, max {max(dl)}; duration ms: median {statistics.median(du):.0f}, max {max(du)}")
    for e in log[-8:]: print(f"  {e['scheduled']} delay={e['delay_ms']}ms dur={e['duration_ms']}ms results={e['results']}")
print("email alerts:", d.get("alerts_email"))
