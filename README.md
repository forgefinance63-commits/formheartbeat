# FormHeartbeat checker (v0.1)

## The promise (strictly provable)

**We verify:**
1. The page is reachable (HTTP 200, with response time).
2. A Contact Form 7 form is present in the served HTML (`form.wpcf7-form`, plus a submit control).
3. The CF7 assets and endpoint respond: the referenced CF7 script returns 200, and the `/wp-json/contact-form-7/v1` REST base answers (200/401/403 count as alive).

**We do NOT verify** that submissions succeed or that leads arrive. No form is ever submitted, so email/SMTP delivery, spam filtering, CAPTCHA, CRM sync, and submit-time errors are all out of scope. An "OK" result means "the form is there and its plumbing answers". It does not mean "leads are being delivered".


External, read-only health check for a WordPress page that should contain a **Contact Form 7** form.

Usage: `python3 checker.py URL [URL...]` → prints JSON per URL, appends one JSON line to `logs/checks.log` (UTC timestamps). Exit code 0 = all OK, 1 = any FAIL.
Tests: `python3 -m unittest discover -s tests -v` (stdlib only, no network).

## What it does (per URL)
1. ONE `GET` of the page (UA `FormHeartbeat/0.1`, 20s timeout). Status must be 200.
2. Parses HTML for CF7 markup: `.wpcf7` wrapper, `<form class="wpcf7-form">` count, a submit control.
3. Finds the CF7 script (`contact-form-7/...js`) and requests it (`HEAD`, falls back to `GET` on 403/405). Must be 200.
4. `GET /wp-json/contact-form-7/v1` (REST namespace base, no form id, no POST). 200/401/403 accepted (REST often locked down); 404, 5xx or network error = problem.

## Detects
- Page down / non-200 / timeout / DNS-TLS errors
- CF7 form removed from the page (e.g. shortcode broken, page rebuilt, plugin deactivated)
- Form rendered without a submit control
- CF7 JavaScript missing from page or returning an error (broken asset/CDN/cache)
- CF7 REST namespace gone (plugin disabled, REST blocked by security plugin/WAF returning 404/5xx)

## Does NOT detect (important)
- **It does not prove a lead was delivered.** It never submits the form.
- Mail failures: SMTP/wp_mail errors, spam-foldering, wrong recipient, deliverability.
- reCAPTCHA/Turnstile misconfiguration or JS runtime errors that only occur on submit (no browser execution).
- Validation/field-level bugs, server-side errors that happen only on POST, CRM/webhook integrations.
- Forms other than CF7; forms injected purely by JS after load.
- Content served differently to bots vs. users (WAF/geo/cookie walls).
End-to-end delivery testing (marked test submission to an agreed inbox) is a separate, opt-in mode requiring the site owner's written permission — not implemented.

## Cloudflare Worker (not deployed)

`worker/` holds the same core logic as an ES-module Worker: a `scheduled()` handler on a Cron Trigger (`*/15 * * * *`), targets from the `TARGETS` var, and logs via `console.log` JSON plus optional `CHECKS_KV` / `CHECKS_DB` (D1, see `schema.sql`) bindings. Local: `node worker/test.mjs`; `npx wrangler dev --test-scheduled`. **Deploy is pending a Cloudflare API token from the owner. Do not deploy without it.**

## GitHub Actions status monitor

`.github/workflows/status.yml` runs every 30 min (`*/30 * * * *`) plus `workflow_dispatch`. It checks a fixed test list with `ci/run_status.py`: contactform7.com/contact = expected `OK`, wordpress.org = expected `FAIL_cf7_form_missing`. It appends JSON lines to `status/checks.log`, rebuilds `docs/index.html` (GitHub Pages) and commits back using `GITHUB_TOKEN` (`contents: write`).

**Heartbeat:** the page computes the age of the last run in the browser and shows **STALE** if there has been no run in 90 min.

**Caveats:** GitHub may delay scheduled runs, especially at busy times like the top of the hour, and sometimes skips them. GitHub disables scheduled workflows in public repos after 60 days with no repository activity. The commit-back on each run counts as activity, but if runs fail before committing, the schedule can still lapse. The staleness banner is there to make that visible.
