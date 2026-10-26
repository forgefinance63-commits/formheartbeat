# FormHeartbeat checker (v0.2)

## The promise (strictly provable)

**We verify, per check, and only at the moment of the check:**
1. **Page reachable**: HTTP 200 (response time recorded).
2. **CF7 form present**: `form.wpcf7-form` and a submit control are in the served HTML.
3. **CF7 assets/endpoint responding**: the referenced CF7 script returns 200. The REST base `/wp-json/contact-form-7/v1` is classified as:
   - `200` means **reachable** (OK)
   - `401/403` means **protected/blocked, so we cannot verify it**. That gives **WARN**, not OK and not FAIL. It only becomes FAIL if it **changed from the site's recorded baseline** (e.g. reachable → protected).
   - anything else (404, 5xx, network error) means **broken** (FAIL)

**We do NOT verify, and this is NOT proof of,** form submission succeeding or leads/emails being delivered. No form is ever submitted. SMTP/mail delivery, spam filtering, CAPTCHA, CRM sync and submit-time JS errors are all out of scope.

**No cadence or alert-time promise yet.** We will not promise "checked every N minutes" or "alerted within N minutes" until the punctuality metrics (`metrics/`) justify it.

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

## Cloudflare Worker (hardened, NOT deployed)

`worker/` (deployment waits for the owner's Cloudflare API token):
- **Auth only, with no public trigger.** Every HTTP endpoint (`GET/POST /v1/targets`, `POST /v1/check`) needs `Authorization: Bearer <key>`. `API_KEYS` is a Worker *secret* that maps the SHA-256 of each key to an account, compared in constant time. Checks also run from the Cron `scheduled()` handler.
- **Limits:** at most 5 targets per account; 6 manual checks per hour and 20 writes per hour per account (KV fixed window); request body capped at 4 KB.
- **URL validation (SSRF):**
  - https only, port 443 only, no userinfo
  - no IP literals or decimal/hex IP forms
  - no localhost/.local/.internal/.corp-style or metadata hostnames
  - **every DNS-resolved A/AAAA address must be public** (DoH lookup): private, loopback, link-local, CGNAT, multicast and IMDS ranges are blocked, including IPv4-mapped IPv6
  - redirects are followed manually (max 3) and **each hop is re-validated**
  - 10 s timeout, 1 MB body cap
  - Remaining risk: DNS can change between our DoH lookup and Cloudflare's own fetch (a TOCTOU gap). Cloudflare Workers can't reach private networks anyway, so this is defense in depth.
- **Minimal data:** KV stores only target URL, optional alert email, last status fields and baseline. Page HTML is never stored.
- **Alerting:**
  - alerts after **2 consecutive FAILs**
  - a single **recovery** notice
  - **dedupe**: no repeat alerts while the problem set is unchanged; it re-alerts if the problem changes
  - WARN never counts as a failure
- **Email:** behind a provider abstraction (`resend` | `mailchannels`). It is **disabled** (`ALERTS_ENABLED="false"`), and keys come only from secrets.
- **Tests:** `node --test worker/test/`, covering SSRF, DNS rebinding, redirects, size cap, REST classes, baseline, alerting, mailer mock, auth and rate limits.

## GitHub Actions / Pages: capability proof only

**This repo and its GitHub Pages site are a technical capability proof, not a commercial service.** No commercial site is or will be hosted on Pages.

Schedule punctuality is recorded each run by `ci/punctuality.py` into `metrics/schedule_punctuality.csv`, comparing the expected */30 slot with the actual start.

### Status monitor

`.github/workflows/status.yml` runs every 30 min (`*/30 * * * *`) plus `workflow_dispatch`. It checks a fixed test list with `ci/run_status.py`: contactform7.com/contact = expected `OK`, wordpress.org = expected `FAIL_cf7_form_missing`. It appends JSON lines to `status/checks.log`, rebuilds `docs/index.html` (GitHub Pages) and commits back using `GITHUB_TOKEN` (`contents: write`).

**Heartbeat:** the page computes the age of the last run in the browser and shows **STALE** if there has been no run in 90 min.

**Caveats:** GitHub may delay scheduled runs, especially at busy times like the top of the hour, and sometimes skips them. GitHub disables scheduled workflows in public repos after 60 days with no repository activity. The commit-back on each run counts as activity, but if runs fail before committing, the schedule can still lapse. The staleness banner is there to make that visible.
