# FormHeartbeat checker (v0.1)

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
