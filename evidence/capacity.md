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
Caveats: the CPU numbers above came from Node; the real Cloudflare numbers are in the next section. Real pages are bigger than the fixtures, but each site now runs in its own invocation. Manual `/v1/check` writes a rate-limit counter (≤6/h per account).

## Real Cloudflare load test (2026-10-28, 10:47–10:56 Asia/Jerusalem)
Owner question: do service bindings' "32 Worker invocations per request" break Cron -> runAccount -> checkSite at 3+ agencies?

**How fan-out is implemented:** service-binding **RPC to itself** (`[[services]] RUNNER -> formheartbeat, entrypoint Runner`). There is no `fetch()` to our own workers.dev; the docs say a same-zone global fetch to another Worker fails. The call tree per tick: 1 scheduled invocation -> N `runAccount` (pool of 6) -> 10 `checkSite` each (pool of 4). **Depth is 3**, and total invocations per tick are 1 + 11·N.

**Setup:** a separate Worker `formheartbeat-loadtest` (free) with the **same production code** and its own KV namespace. It ran a `* * * * *` cron plus a test-only HTTP trigger running the same `runTick`. Synthetic agencies lt01–lt30 × 10 targets, all pointing at our own static landing page (`https://getformheartbeat.com/?lt=…`, served as a static asset with no Worker/KV involvement). Alerts were disabled. Production Worker and KV were not touched. Both the test Worker and its KV were **deleted** afterwards (404 verified). Harness: `worker/loadtest/`. Raw data: `evidence/capacity-real.json`.

| Agencies × 10 | Trigger | Invocations in one request | Sites checked | Errors | Duration |
|---|---|---|---|---|---|
| 1 | HTTP | 11 | 10/10 | 0 | 0.24 s |
| 3 | HTTP | 34 | 30/30 | 0 | 0.29 s |
| 5 | HTTP | 56 | 50/50 | 0 | 1.6 s |
| 5 | **real cron** 08:53Z | 56 | 50/50 | 0 | 0.32 s |
| 10 | HTTP | 111 | 100/100 | 0 | 1.8 s |
| 30 | HTTP | 331 | 300/300 | 0 | 7.0 s |
| 30 | **real cron** 08:49Z, 08:50Z | 331 | 300/300 (×2) | 0 | 1.1 s / 2.5 s |

Invocation counts were confirmed by Cloudflare GraphQL analytics: the 08:50Z minute (one cron tick, 30 agencies) shows **331 requests, 0 errors, 1,230 subrequests**.
**CPU per invocation** (GraphQL, real): p50 2.5 ms, p99 6.5 ms, p99.9 11.3 ms at 30 agencies; p99 ≤ 9 ms in every other run. The occasional >10 ms invocation was not terminated (no `exceededCpu` status). That is headroom we should not rely on; each invocation is small because of the per-site split.

**Limit probes (real, same Worker):**
- RPC chain depth 31 -> ok. Depth 33/40 -> `Subrequest depth limit exceeded … passed through too many Workers stages`. **The "32" limit is chain depth, not total fan-out.** We use depth 3.
- One invocation making 50 RPC calls -> ok; 51 -> `Too many subrequests by single Worker invocation`. **Service-binding calls count toward the 50 free subrequests.**
- 50 RPC calls + 20 KV reads in one invocation -> ok. **KV ops do not count toward the 50** (they fall under the 1,000 internal-ops limit).
- Implication: the cron invocation may call at most 50 accounts (`MAX_ACCOUNTS_PER_TICK = 40`, with sharding beyond that). `runAccount` makes 10 RPC calls plus ≤4 KV ops. `checkSite` measured 3–5 fetches (budget 45).

**Result: no limit was hit at 1/3/5/10/30 agencies, so no architecture change was needed and nothing was redeployed.** Production stays on bf8858f3; its 09:00Z (11:00 Asia/Jerusalem) tick ran normally: 2/2 checked, 0 missed slots. Queues (free plan, 10k ops/day) and multi-cron sharding were evaluated but not needed. Queues would cost about 288 ops per account per day and would itself cap us at about 34 agencies.
**KV ops per tick (code + production analytics):** reads = 1 (cron:log) + 2 per account; writes = 1 (cron:log) + ≤1 state (only on change) + ≤1 alerts (only on alert). Production's 08:45Z tick showed 4 reads and 1 write, matching that.
**Corrected max capacity: unchanged, ~30 agencies / ~300 sites typical, 5 / 50 guaranteed.** KV writes (1k/day) are the binding limit, not invocations, depth, subrequests or CPU. Request budget at 30 agencies is 331 × 96 ≈ 32k of the 100k/day.
Test cost: $0. The test used about 100 KV writes and about 2k requests from the shared daily free quota.
