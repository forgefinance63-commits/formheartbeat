# Email domain setup: getformheartbeat.com (2026-10-28, Asia/Jerusalem)

## Done (temporary DNS token, value never printed)
Added DNS-only records, all confirmed via Cloudflare DoH:
- TXT @ `brevo-code:fa802d0501885084898db8fb19d738d2`
- CNAME brevo1._domainkey -> b1.getformheartbeat-com.dkim.brevo.com
- CNAME brevo2._domainkey -> b2.getformheartbeat-com.dkim.brevo.com
- TXT _dmarc `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com`
Not touched: AAAA 100:: records for @ and www, which are read-only and serve the landing Worker custom domain.
No SPF record added. Per Brevo docs SPF/MX are not required for shared-IP domain auth; DMARC alignment comes from DKIM. SPF will come from Email Routing.

## Blocked
- Email Routing enable/DNS (`GET/POST zones/:id/email/routing`, `/email/routing/dns`): Authentication error 10000. The token can list rules and addresses but cannot read or enable the Email Routing settings.
- Brevo API: key is restricted, `permission_denied` for resource "account" on /v3/senders/domains. Authentication must be clicked in the Brevo UI.

## Pending
hello@/alerts@ routing, inbound test, ALERT_FROM switch, header (SPF/DKIM/DMARC) check, Outlook test. The landing mailto stays forgefinance63@gmail.com until routing works.
