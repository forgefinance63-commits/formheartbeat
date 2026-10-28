# Capacity on the Cloudflare Workers Free plan (2026-10-28)

## Before (measured from code, version a3cae573)
Per cron tick: 1 KV write per target (`state:*`, written every tick even if nothing changed) + `cron:log` + `cron:last`, all sites checked sequentially in ONE invocation.
Each check = page + script + endpoint fetch, and every hop also does 2 DNS-over-HTTPS lookups -> ~9 subrequests per site.
- KV writes/day = (targets + 2) x 96 -> 2 sites = 384/day; **8 sites = 960/day (limit 1,000)**.
- Subrequests: 10 sites x ~9 = ~90 in one invocation -> **over the 50/invocation free limit with a single 10-site agency**.

## After (version bf8858f3, deployed 2026-10-28 10:26 Asia/Jerusalem)
- **One state key per account** (`st:<acct>`), written **only when something changed** (result, alert flag, baseline). Per-tick noise (timestamps, latency, ever-growing streak counters) is no longer persisted; counters are capped at the threshold, which keeps alert semantics (existing tests unchanged; worker suite 21/21, site suite 4/4).
- **Cron log**: one ring-buffered key (`cron:log`, 672 entries ≈ 7 days), `cron:last` removed -> 1 write/tick.
- **Fan-out with a self service binding** (`env.RUNNER` -> `Runner` entrypoint): cron -> 1 invocation per account -> 1 invocation per site. Each invocation has its own 50-subrequest and CPU budget.
- **Per-site subrequest budget (45)** + per-invocation DNS memo. Over budget -> the check is UNVERIFIABLE (transient), never a false FAIL.
- **Account sharding**: more than 40 accounts -> they rotate across ticks (each site checked every 30 min instead of 15). No cadence is promised.
- One-time migration from the old `state:*` keys. Old keys are left in place (they are harmless) so a rollback keeps its data.

## Simulated load test (`worker/test/loadsim.mjs`, also a unit test)
Mocked fetch/DNS/KV; each account = 10 sites (6 steady OK, 1 flapping 3×/day, 1 permanently down, 1 behind a 3-hop redirect, 1 OK); 96 ticks = 1 day. Raw output: `evidence/capacity-sim.json`.

| accounts | sites | KV writes/day | KV reads/day | max subreq / site invocation | binding calls / cron invocation | CPU / site check avg / p95 (Node, local) |
|---|---|---|---|---|---|---|
| 1 | 10 | 111 | 391 | 12 | 1 | 1.2 / 4.7 ms |
| 5 | 50 | 171 | 1,571 | 12 | 5 | 2.0 / 5.4 ms |
| 40 | 400 | 696 | 11,896 | 12 | 40 | 1.8 / 4.1 ms |
| 80 | 800 (2 shards) | 976 | 12,096 | 12 | 40 | 1.8 / 4.3 ms |

Unchanged tick = **1 KV write** (cron log). Free limits: KV 1,000 writes / 100,000 reads per day, 50 subrequests/invocation, 10 ms CPU, 100,000 requests/day.

## Live verification
- Manual `/v1/check` after the deploy went through the RPC path: contactform7.com OK (5 subrequests), wordpress.org FAIL control (3 subrequests). State migrated, no duplicate alert (alerts log still 4).
- Cron 08:30Z (10:30 Asia/Jerusalem) tail: `default */15` ok -> `Runner.runAccount` ok -> 2× `Runner.checkSite` ok; cron log entry `{n:2, counts:{OK:1,FAIL:1}, duration_ms:573}`.
- Rollback: `wrangler rollback a3cae573-51c6-4a99-96bc-279219240f9e` (old code still reads the old `state:*` keys).

## Maximum supported sites (free plan)
Shared KV write budget: 1,000/day. Reserve ~150 for landing analytics (hard cap), ~100 for pilot requests, rate limits and manual checks -> **~600/day for monitoring**.
- **Typical (sim change rate): ~30 agencies / ~300 sites** (≈ 96 + 15 writes per account per day ≈ 550/day; requests ≈ 35k/day).
- **Guaranteed floor, even if every account changed state every tick: 5 agencies / 50 sites.**
- The binding is subrequest-safe up to 40 accounts per tick, and sharding goes beyond that. KV writes are the binding limit, not subrequests or CPU.
- Next step if we outgrow this (owner decision, not done): move state to D1 (100k writes/day free) or Workers Paid ($5/mo).
Caveats: CPU was measured in Node on the box, not on Cloudflare. Real pages are bigger than the fixtures, but each site now runs in its own invocation. Manual `/v1/check` writes a rate-limit counter (≤6/h per account).
