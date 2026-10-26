# Deploy runbook: Cloudflare Worker (workers.dev, free plan). DEPLOYED 2026-10-27.

## Status (2026-10-27 00:35 IST): DEPLOYED (see evidence/worker-deploy.md)
- Deployed to https://formheartbeat.formheartbeat.workers.dev on the free plan. Alerts are still disabled.
- Per-account target limit is **10**, matching the pilot offer. Rate limits: 20 writes/hour and 6 manual checks/hour.
- Tests: Python 18/18 and Worker 13/13. This includes the optimizer-bundle test and the `MAX_TARGETS == 10` check.

## Steps (owner, or an agent once a token is provided)
1. Create the token in the Cloudflare dashboard: **My Profile → API Tokens → "Edit Cloudflare Workers" template**, scoped to this one account. The Workers Free plan costs nothing; don't add a card.
2. `export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...`
3. `cd worker && npx wrangler@3 kv namespace create KV`. Put the returned id into `[[kv_namespaces]]` in wrangler.toml.
4. Generate an API key per pilot account: `openssl rand -hex 24`. Store the sha256 of the key, not the key itself:
   `npx wrangler secret put API_KEYS` with the value `{"<sha256>":"pilot-1"}`.
5. `npx wrangler deploy`. This gives you `https://formheartbeat.<subdomain>.workers.dev`.
6. Smoke test:
   - `curl -H "authorization: Bearer <key>" -XPOST .../v1/targets -d '{"url":"https://contactform7.com/contact/"}'`
   - then `POST .../v1/check`;
   - expect OK.
   - Try an 11th target and expect `403 max_targets`.
7. Alerts stay `ALERTS_ENABLED="false"` until a sending path exists (see below). When one does:
   - put its secrets in Worker secrets;
   - set `ALERTS_ENABLED="true"`;
   - send one test alert to forgefinance63@gmail.com;
   - record the timestamp and the Gmail receipt in evidence/.
8. Rollback: `npx wrangler rollback`, or `npx wrangler delete`.

## Alert path options (no paid signup allowed)
| Path | New account? | Cost | Status |
|---|---|---|---|
| MailChannels free Workers API | — | — | **Shut down 30 Jun 2024.** It now needs a MailChannels account and API key, so it is unusable under our rules. |
| Resend free tier | Yes (signup) | Free tier, needs a verified sending domain | Pending owner approval. We have no domain, and buying one is spending. |
| Cloudflare Email Routing `send_email` binding | No new vendor | Free | Needs a domain on Cloudflare and a verified destination address. **Blocked: no domain.** |
| GitHub Actions + Gmail SMTP | No | Free | Needs a Gmail app password as a repo secret. **Not available** (the owner said so). |
| **Fallback with no new account:** the Worker records `operator_alert` in its logs and KV state, and the owner reads it with `wrangler tail`, a status endpoint or GitHub Issues | No | Free | Implemented (`operator_alert` log and state). Not push delivery. |
