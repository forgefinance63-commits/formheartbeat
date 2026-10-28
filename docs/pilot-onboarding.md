# Pilot onboarding (public, sanitized)

What a FormHeartbeat pilot looks like. No customer data here.

**Offer (unchanged):** 14-day free pilot, no card. Afterwards $19/mo for up to 10 sites, **only if you explicitly opt in**. If you don't reply, monitoring stops and your data is deleted.

1. **Request**: use the form on getformheartbeat.com, or email hello@getformheartbeat.com with your agency name and up to 10 contact-page URLs (https).
2. **Setup (manual, best effort)**: we create your account, add your sites and run a first check. You get an email with your API key, the first results (OK / FAIL / UNVERIFIABLE, and why) and one labelled TEST alert, so you can whitelist alerts@getformheartbeat.com.
3. **During the pilot**: read-only external checks on a schedule (no promised cadence; it never submits forms). An alert is sent after 2 consecutive failed checks, plus one recovery notice.
4. **Touchpoints**: day 1 (setup + results), day 7 (short summary, questions), day 12 (reminder that the trial ends, with the opt-in choice), day 14 (stop or continue).
5. **Support**: email hello@getformheartbeat.com. A real person reads it, best effort, no guaranteed response time.
6. **End of the pilot**: continue at $19/mo only with your explicit yes. Otherwise we revoke the key and delete your targets, check state and alerts when the pilot ends. You can ask for deletion at any time.

API: `GET/POST /v1/targets`, `GET /v1/status`, `POST /v1/check` (Bearer key; at most 10 sites, 6 manual checks per hour).
