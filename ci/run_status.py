"""Run checker against fixed test list, append to status/checks.log, build docs/index.html."""
import json, os, datetime, subprocess, sys, html
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from checker import check
from zoneinfo import ZoneInfo
TARGETS = [("https://contactform7.com/contact/", "OK"),
           ("https://wordpress.org/", "FAIL_cf7_form_missing")]
event = os.environ.get("GITHUB_EVENT_NAME", "local"); run_id = os.environ.get("GITHUB_RUN_ID", "")
now = datetime.datetime.now(datetime.timezone.utc)
os.makedirs("status", exist_ok=True); os.makedirs("docs", exist_ok=True)
rows = []
for url, exp in TARGETS:
    r = check(url)
    actual = "OK" if r["result"] == "OK" else "FAIL_" + "_".join(r["problems"])
    line = {"ts": now.isoformat(timespec="seconds"), "event": event, "run_id": run_id, "url": url,
            "expected": exp, "actual": actual, "match": actual == exp, "detail": r}
    open("status/checks.log", "a").write(json.dumps(line) + "\n")
    rows.append(line)
json.dump({"last_run_utc": now.isoformat(timespec="seconds"), "event": event, "run_id": run_id,
           "rows": [{k: v for k, v in x.items() if k != "detail"} for x in rows]},
          open("docs/status.json", "w"), indent=1)
il = now.astimezone(ZoneInfo("Asia/Jerusalem"))
tr = "".join(f"<tr><td>{html.escape(x['url'])}</td><td>{x['expected']}</td><td>{x['actual']}</td><td>{'✅' if x['match'] else '❌'}</td></tr>" for x in rows)
page = f"""<!doctype html><meta charset=utf-8><title>FormHeartbeat status</title>
<style>body{{font-family:sans-serif;max-width:800px;margin:2em auto}}td,th{{border:1px solid #ccc;padding:4px 8px}}#stale{{padding:8px;font-weight:bold}}</style>
<h1>FormHeartbeat – Day-1 capability status</h1>
<div id=stale></div>
<p>Last run: <b>{now:%Y-%m-%d %H:%M:%S} UTC</b> / <b>{il:%Y-%m-%d %H:%M:%S} Israel time</b> · event: <b>{event}</b> · run <a href="https://github.com/{os.environ.get('GITHUB_REPOSITORY','')}/actions/runs/{run_id}">{run_id}</a></p>
<table><tr><th>URL</th><th>Expected</th><th>Actual</th><th>Match</th></tr>{tr}</table>
<p><small>Read-only checks: page reachable, CF7 form present, CF7 script + REST base respond. Does NOT verify submissions or lead delivery.</small></p>
<script>
const last=Date.parse("{now.isoformat()}");const m=(Date.now()-last)/60000;const s=document.getElementById('stale');
if(m>90){{s.textContent='⚠️ STALE: no run for '+Math.round(m)+' min (threshold 90)';s.style.background='#fdd'}}
else{{s.textContent='Heartbeat fresh: last run '+Math.round(m)+' min ago';s.style.background='#dfd'}}
</script>"""
open("docs/index.html", "w").write(page)
bad = [x for x in rows if not x["match"]]
print(json.dumps([{k:v for k,v in x.items() if k!='detail'} for x in rows], indent=1))
sys.exit(1 if bad else 0)
