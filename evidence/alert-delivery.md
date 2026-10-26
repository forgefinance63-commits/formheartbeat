# Alert delivery test (Brevo free plan), 2026-10-27

Setup: Worker version 74be2f7d, `EMAIL_PROVIDER=brevo`, `ALERTS_ENABLED=true`. The only recipient is the internal-test inbox (the operator's own Gmail). The sender is a Brevo-verified Gmail address. Free plan, no payment method, 0 spent.

## Results (Israel time = UTC+2)
| # | trigger | check ts (Worker) | Gmail Date / received | latency | folder |
|---|---|---|---|---|---|
| 1 | wordpress.org control, state reset, then 2 manual checks -> `down` | 00:55:40.1 | 00:55:41 / Google MX 00:55:42 | ~2 s | Inbox (Updates tab) |
| 2 | contactform7.com, state seeded as alerted (synthetic), passing check -> `recovered` | 00:56:28.2 | 00:56:28 | <1 s | Inbox (Updates tab) |

Dedupe: after alert 1, a manual check at 00:55:43, a manual check at 00:56:28 and the 01:00 cron run (results OK, FAIL) all saw wordpress.org still failing. None produced another alert record or email. Gmail shows exactly 2 FormHeartbeat messages in all folders.

## Sender and authentication
- From header was **rewritten**: `FormHeartbeat <forgefinance63@12590586.brevosend.com>`. Brevo will not send freemail From addresses unchanged, because of Gmail's DMARC policy.
- Return-Path: Brevo bounce domain (sender-sib.com).
- `dkim=pass` (brevosend.com), `spf=pass` (sender-sib.com), `dmarc=pass` (header.from=brevosend.com, p=REJECT).
- Placement: Inbox, Updates category. Not spam.

## Limits / not proven
- n=2 messages to one Gmail inbox. Not tested with Outlook or business mailboxes, and no long-run reliability data.
- The failure-delivery retry path is unit-tested (mocked 500) but has not been tested against a real Brevo outage.
- Branding: customers would see a brevosend.com address, which hurts trust and the chance of being allowlisted.
- Latency is measured from the start of the check. Cron cadence and cron delay are tracked separately (`scripts/cron_summary.py`); no cadence is promised.
