"""Record scheduled-run punctuality (expected cron slot vs actual start) from `gh run list`.
Usage: python ci/punctuality.py [owner/repo]   -> rewrites metrics/schedule_punctuality.csv + prints summary.
Cron is */30, so the expected slot = actual createdAt floored to :00/:30 (UTC). Delays > 30 min can't be told
apart from skipped slots, so missing slots are counted separately."""
import json, subprocess, sys, datetime as dt, csv, os, statistics
repo = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("GITHUB_REPOSITORY", "forgefinance63-commits/formheartbeat")
out = subprocess.run(["gh", "run", "list", "-R", repo, "-w", "status-check", "-e", "schedule", "-L", "1000",
                      "--json", "databaseId,createdAt,startedAt,conclusion"], capture_output=True, text=True, check=True).stdout
runs = sorted(json.loads(out), key=lambda r: r["createdAt"])
P = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
rows = []
for r in runs:
    c = P(r["createdAt"]); slot = c.replace(minute=0 if c.minute < 30 else 30, second=0, microsecond=0)
    rows.append({"run_id": r["databaseId"], "expected_slot_utc": slot.isoformat(), "created_utc": c.isoformat(),
                 "started_utc": r.get("startedAt") or "", "delay_min": round((c - slot).total_seconds() / 60, 1),
                 "conclusion": r["conclusion"]})
os.makedirs("metrics", exist_ok=True)
with open("metrics/schedule_punctuality.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["run_id", "expected_slot_utc", "created_utc", "started_utc", "delay_min", "conclusion"])
    w.writeheader(); w.writerows(rows)
d = [r["delay_min"] for r in rows]
if rows:
    first, last = P(rows[0]["expected_slot_utc"]), P(rows[-1]["expected_slot_utc"])
    expected_slots = int((last - first).total_seconds() // 1800) + 1
    summ = {"scheduled_runs": len(rows), "slots_in_span": expected_slots, "missed_slots": expected_slots - len({r['expected_slot_utc'] for r in rows}),
            "delay_min_median": statistics.median(d), "delay_min_p90": sorted(d)[int(0.9 * (len(d) - 1))], "delay_min_max": max(d),
            "span_utc": [rows[0]["expected_slot_utc"], rows[-1]["expected_slot_utc"]]}
else: summ = {"scheduled_runs": 0}
json.dump(summ, open("metrics/schedule_punctuality_summary.json", "w"), indent=1); print(json.dumps(summ))
