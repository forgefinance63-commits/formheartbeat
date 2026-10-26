# Worker deployment evidence (2026-10-27, Israel time / UTC+2)

- **URL:** https://formheartbeat.formheartbeat.workers.dev. It runs on workers.dev, with no custom domain or routes.
- **Plan:** Workers Free. Resources used: 1 Worker, 1 KV namespace and 1 Cron Trigger (`*/15 * * * *`). No D1, Queues, Durable Objects, paid add-ons or payment method were used, and wrangler never asked for billing. **Cost: $0.**
  - The cron runs on a best-effort basis, and **no check cadence is promised.**
- **Version:** 539397dd-d121-48b7-9c4c-087f4e2c2372, deployed with wrangler 4.86.0.
- **Secrets:** `API_KEYS` holds only the sha256 of the API key. The plaintext key is stored outside the repo, with mode 600.
- **Alerts:** `ALERTS_ENABLED="false"`, and no email provider is configured. Alerts are recorded in KV (`alerts:<acct>`, read through `GET /v1/status`) and in Worker logs (`alert_recorded`).
- **Internal test account** `internal-test`. Targets: `https://contactform7.com/contact/` (positive control) and `https://wordpress.org/` (negative control, deliberately with no contact form).

## Live verification
| Test | Request | Expected | Observed (00:22 IST) |
|---|---|---|---|
| Unauthenticated | GET /v1/targets, POST /v1/check, GET /v1/status with no key | 401 | 401 ×3 |
| Wrong key | Bearer with a random 32-character key | 401 | 401 |
| SSRF: metadata IP | https://169.254.169.254/latest/meta-data/ | 400 | 400 `private_ip` |
| SSRF: loopback / RFC1918 / IPv6 | 127.0.0.1, 10.0.0.1, [::1] | 400 | 400 `private_ip` |
| SSRF: localhost / plain http | https://localhost/, http://… | 400 | 400 `non_public_hostname`, `https_only` |
| SSRF: DNS name resolving to a private IP | 127.0.0.1.nip.io, localtest.me | 400 | 400 `resolves_to_private_ip` |
| Positive control | manual check | OK | OK (cf7, REST reachable) |
| Negative control | manual check | FAIL | FAIL `contact_form_missing` |

## Cron evidence (stored state `cron:last`)
- cron `*/15 * * * *`
- scheduled time 2026-10-27 00:30:42 IST; started 00:30:44; finished 00:30:46 IST
- 1 account; results [OK, FAIL]

`wrangler tail` disconnected before the tick, so the evidence comes from stored KV state rather than the log stream.

## Alert state machine (negative control)
1. 00:22 manual check: FAIL, consecutiveFails=1, no alert. The threshold is 2.
2. 00:30 **cron** tick: FAIL, consecutiveFails=2. A **`down` alert was recorded** (`contact_form_missing`, 00:30:45 IST). It was not emailed, because alerts are disabled.
3. 00:31 manual check: FAIL, consecutiveFails=3. Alert count stayed at 1, so the duplicate was suppressed.
4. Recovery (OK after alerted gives a `recovered` alert) was not exercised live, because the control is permanently failing. It is covered by the Worker unit test `alerting: 2 consecutive fails, dedupe, recovery`.

## Not verified / pending
- Email delivery of alerts, which needs an approved provider (see DEPLOY.md).
- Long-run cron punctuality, which needs to be measured over days before anything is promised.
- The billing page itself. The API token can't read subscriptions; the account settings API reports `default_usage_model: standard`.
