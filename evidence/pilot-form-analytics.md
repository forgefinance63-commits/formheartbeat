# Landing analytics + pilot form (2026-10-28, site Worker version 59ae5d4e)

## Analytics (cookie-less, no PII)
- **Cloudflare Web Analytics**: the token can't create a Web Analytics site (`rum/site_info` create -> 10000 auth error). But Cloudflare already injects the RUM beacon on the zone, and the old CSP was blocking it (console error captured). The CSP now allows `script-src https://static.cloudflareinsights.com` and `connect-src https://cloudflareinsights.com`, and the beacon loads with 0 console errors. Owner view: Cloudflare dashboard -> Analytics & Logs -> Web Analytics -> getformheartbeat.com (cookie-less page views, referrers, countries).
- **First-party counters (CTA clicks + page views)**: `/app.js` -> `sendBeacon('/api/e')`. The site Worker keeps a daily aggregate in a private KV key `an:YYYY-MM-DD` with no IDs, cookies or IP. Same-origin only, and bot/headless UAs are ignored. **Hard cap of 150 KV writes/day**, so the shared 1,000-write budget stays with monitoring; past the cap counting stops for the day (`capped:true`).
  CTA ids: `nav, hero, pricing, final, mailto-form, mailto-final, mailto-footer`.
  Owner view: `python3 scripts/fh_admin.py stats` (or `GET /api/stats` with the private STATS_KEY). Unauthenticated -> 401 (verified).
  Today's counts include one test pv and one `cta:test-curl` from verification.
- CSP now: `default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'`.

## Pilot form
- Fields: agency, email, up to 10 https URLs, consent checkbox (required), and a honeypot. CTAs scroll to `#pilot`. Mailto stays as a fallback next to the form, in the final CTA and in the footer.
- `POST /api/pilot` (site Worker, `run_worker_first=["/api/*"]`):
  1. validate, same-origin check, 8 KB cap;
  2. rate limit at 3/hour per daily-rotating salted IP hash (raw IP never stored), 25/day globally;
  3. store `pilot:<id>` in the private `SITE_KV` (not the repo);
  4. Brevo email **to hello@getformheartbeat.com only** (Reply-To = applicant).
  No auto-provisioning.
- Unit tests: `site-worker/test/site.test.mjs` 4/4 (validation, storage, owner-only notify, rate limit 201,201,429, foreign origin 403, consent 422, analytics cap, stats auth).
- **Live E2E (one real submission, 2026-10-28 10:28 Asia/Jerusalem)**: Playwright on https://getformheartbeat.com clicked the hero CTA, filled the form (agency "FormHeartbeat internal E2E test", the owner's own address, 1 site) and submitted -> 201 `20261028T082824098Z-56823b4a`. The success message showed. The email "[Pilot request] FormHeartbeat internal E2E test (1 site)" from alerts@getformheartbeat.com arrived in the owner's Gmail INBOX at 08:28:25Z. `fh_admin.py requests` lists it.
- Rollback: `cd site-worker && wrangler rollback b3050f75-68b0-474a-9a53-23f43e373162`. The static page rollback is saved privately.
