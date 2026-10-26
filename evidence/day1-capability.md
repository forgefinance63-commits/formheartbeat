# Day-1 capability test: GitHub Actions + Pages

- Repo: https://github.com/forgefinance63-commits/formheartbeat (public; history scanned for tokens/keys/passwords before push, none found)
- Pages: https://forgefinance63-commits.github.io/formheartbeat/ (branch master, /docs)
- Workflow: [.github/workflows/status.yml](../.github/workflows/status.yml), cron `*/30 * * * *` + workflow_dispatch, contents: write, GITHUB_TOKEN commit-back
- Runner: ci/run_status.py; log: status/checks.log; page: docs/index.html (90-min staleness banner computed client-side)

## Runs (timestamps UTC; Israel = UTC+2)
| run id | workflow | event | created | conclusion |
|---|---|---|---|---|
| 40324044187 | pages-build-deployment | dynamic | 2026-10-26T12:38:06Z | success |
| 40324017781 | status-check | workflow_dispatch | 2026-10-26T12:37:54Z | success |
| 40323949201 | pages-build-deployment | dynamic | 2026-10-26T12:37:22Z | success |
| 40323716662 | pages-build-deployment | dynamic | 2026-10-26T12:35:34Z | success |

## Expected vs actual (manual run 40324017781, 2026-10-26 12:38:01 UTC / 14:38:01 Israel)
| URL | expected | actual | match |
|---|---|---|---|
| https://contactform7.com/contact/ | OK | OK | yes |
| https://wordpress.org/ | FAIL_cf7_form_missing | FAIL_cf7_form_missing | yes |

## Sample log lines (truncated)
```
{"ts": "2026-10-26T12:38:01+00:00", "event": "workflow_dispatch", "run_id": "40324017781", "url": "https://contactform7.com/contact/", "expected": "OK", "actual": "OK", "match": true, "detail": {"timestamp": "2026-10-26T12:38:01+00:00", "url": "https://contactform7.com/contact/", "checks": {"page": 
{"ts": "2026-10-26T12:38:01+00:00", "event": "workflow_dispatch", "run_id": "40324017781", "url": "https://wordpress.org/", "expected": "FAIL_cf7_form_missing", "actual": "FAIL_cf7_form_missing", "match": true, "detail": {"timestamp": "2026-10-26T12:38:03+00:00", "url": "https://wordpress.org/", "ch
```

## Schedule verification: PASSED (late)
First run with event == schedule: **40346097875**, created 2026-10-26T15:06:49Z (**17:06 Israel time**), conclusion success.
Earlier note (13:06 UTC / 15:06 Israel) recorded no scheduled run yet; the first one arrived ~2.5 h after the workflow was created. This confirms GitHub schedules work but can lag badly, so no cadence is promised.
Verify: `gh run list -R forgefinance63-commits/formheartbeat -w status-check -e schedule`

## Caveats
Scheduled runs can be delayed or dropped. Schedules are disabled after 60 days without repo activity (the commit-back keeps the repo active). The staleness banner shows when runs stop.
