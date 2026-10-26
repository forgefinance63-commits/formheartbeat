# FormHeartbeat: WordPress contact form checker (v0.3)

## The promise (strictly provable) — WordPress contact forms

**Supported (validated on real sites, see [evidence/plugin-validation.md](evidence/plugin-validation.md)): WPForms, Gravity Forms, Elementor Forms.**
Experimental (detected, but real-site accuracy not yet documented; results are marked `coverage: experimental`): Contact Form 7, Ninja Forms, Fluent Forms, Formidable, generic `<form>` with an email field. Generic detection is known to match newsletter forms.

**Three result states:**
- **OK**: every check below passed, within the defined coverage.
- **FAIL**: a detected failure (page not 200, form or submit control missing, a referenced plugin script failing, an endpoint error, or a baseline change).
- **UNVERIFIABLE**: we could not verify. Examples: a 401/403 endpoint, a bot-protection challenge, or JS combined by a cache/optimizer plugin. **Persistent bot blocking (3 consecutive checks) is a *monitoring* problem raised to the operator. It is not reported as a form failure.**

**Reachability is not submit-ability.** A plugin JS asset returning 200, or `admin-ajax.php`/REST answering a GET, does **NOT** prove that the form can submit. It only shows that those pieces are reachable at check time.

**We verify, from outside and only at the moment of each check (GET/HEAD requests only, a form is never submitted):**
1. **Page reachable**: HTTP 200.
2. **Contact form present**: the form plugin is detected by its markup, and a submit control is present. Ninja Forms renders its form with JavaScript, so for Ninja only the form container and script are checked.
3. **Form JS asset loads**: the plugin's referenced script returns 200.
4. **Plugin endpoint responds (GET only)**: the CF7 REST base, or `admin-ajax.php` for AJAX-submitting plugins (where 400 "0" means reachable). **401/403 → UNVERIFIABLE**, never FAIL on its own.
5. **Baseline change**: a site's first verified check becomes its baseline. A plugin disappearing or an endpoint class changing gives FAIL.

**Bot protection.** Challenge pages are reported as **UNVERIFIABLE**, never FAIL. This covers SiteGround sgcaptcha, Cloudflare "Just a moment", Sucuri firewall, and HTTP 202/403/429/503 responses with captcha markers. If it **persists for 3 consecutive checks on a previously verified site**, the operator gets a `monitoring_problem` alert. The site is not marked FAIL.

**Discovery** (`checker.py --scan https://site/`) checks the homepage, **every** same-site contact/get-in-touch/quote link, and `/contact`, `/contact-us`, `/get-in-touch` and `/quote`.

**We do NOT verify, and this is NOT proof of,** a submission succeeding or a lead/email being delivered. That includes SMTP/mail delivery, spam filters, CAPTCHA on submit, CRM sync and submit-time JS errors.

**No cadence or alert-time promise yet.** That waits until `metrics/` punctuality data justifies one.

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

`.github/workflows/status.yml` runs every 30 min (`*/30 * * * *`) plus `workflow_dispatch`. It checks a fixed test list with `ci/run_status.py`: contactform7.com/contact = expected `OK`, wordpress.org = expected `FAIL_contact_form_missing`. It appends JSON lines to `status/checks.log`, rebuilds `docs/index.html` (GitHub Pages) and commits back using `GITHUB_TOKEN` (`contents: write`).

**Heartbeat:** the page computes the age of the last run in the browser and shows **STALE** if there has been no run in 90 min.

**Caveats:** GitHub may delay scheduled runs, especially at busy times like the top of the hour, and sometimes skips them. GitHub disables scheduled workflows in public repos after 60 days with no repository activity. The commit-back on each run counts as activity, but if runs fail before committing, the schedule can still lapse. The staleness banner is there to make that visible.
