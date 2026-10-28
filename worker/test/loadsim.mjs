// Simulated capacity load test: N accounts x 10 sites x 96 ticks (1 day at */15) with mocked fetch/DNS/KV.
// Counts KV reads/writes, per-invocation subrequests, and CPU per site check. Usage: node test/loadsim.mjs [N ...]
import { readFileSync } from "node:fs";
import { runTick, runAccount, checkSite, SUBREQUEST_BUDGET, accountsForTick } from "../src/index.js";
const fx = n => readFileSync(new URL(`../../tests/fixtures/${n}.html`, import.meta.url), "utf8");
const OKHTML = fx("present");
export function countingKV() { const m = new Map(), c = { reads: 0, writes: 0 };
  return { m, c, get: async k => (c.reads++, m.get(k) ?? null), put: async (k, v) => { c.writes++; m.set(k, v); } }; }
// site kinds: ok (steady), down (steady FAIL), flap (FAIL for 3 ticks every 32 ticks => ~3 incidents/day), slow-redirect (3 hops)
function siteFetch(kind, tick) {
  return async (url, o = {}) => {
    const fail = kind === "down" || (kind === "flap" && tick % 32 < 3);
    if (kind === "redir" && !url.includes("hop3")) return new Response("", { status: 301, headers: { location: url.replace(/(hop\d)?\/?$/, m => `/hop${(+(m.match(/\d/)?.[0] || 0)) + 1}`) } });
    if (url.includes("wp-json")) return new Response("{}", { status: fail ? 404 : 200 });
    if (url.endsWith(".js")) return new Response("", { status: 200 });
    return new Response(fail ? "<html>no form</html>" : OKHTML, { status: 200 });
  };
}
export async function simulate(N, { sites = 10, ticks = 96 } = {}) {
  const kv = countingKV(); const keys = {}; const kinds = ["ok", "ok", "ok", "ok", "ok", "ok", "flap", "down", "redir", "ok"];
  for (let a = 0; a < N; a++) { keys["h" + a] = "acct" + a;
    await kv.put(`acct:acct${a}:targets`, JSON.stringify(Array.from({ length: sites }, (_, i) => ({ url: `https://a${a}s${i}-${kinds[i % 10]}.example.com/contact/`, alert_email: null })))); }
  kv.c.reads = 0; kv.c.writes = 0;
  const t0 = Date.parse("2026-10-28T00:00:00Z"); let tick = 0, maxSiteSub = 0, maxCronCalls = 0, maxAcctCalls = 0, cpuMax = 0, cpuSum = 0, checks = 0;
  const resolve = async () => ["93.184.216.34"];
  // fake self service binding: every call = separate invocation with its own budget (as on Cloudflare)
  const env = { KV: kv, API_KEYS: JSON.stringify(keys), ALERTS_ENABLED: "false" };
  const acctCalls = {}; const cpus = [];
  env.RUNNER = {
    runAccount: async a => { acctCalls[a] = 0; const r = await runAccount(env, a); maxAcctCalls = Math.max(maxAcctCalls, acctCalls[a]); return r; },
    checkSite: async (a, t, prev) => { acctCalls[a]++; const kind = t.url.split("-")[1].split(".")[0];
      const fetchImpl = siteFetch(kind, tick);
      const c0 = process.cpuUsage(); const r = await checkSite({ ...env, RUNNER: undefined }, a, t, prev, { fetchImpl, resolve: async h => { await fetchImpl("doh"); return resolve(h); }, retryDelay: 0 });
      const c = process.cpuUsage(c0); const ms = (c.user + c.system) / 1000; cpuMax = Math.max(cpuMax, ms); cpus.push(ms); cpuSum += ms; checks++;
      maxSiteSub = Math.max(maxSiteSub, r.result.subrequests); return structuredClone(r); },
  };
  const perTick = [];
  for (tick = 0; tick < ticks; tick++) { const w0 = kv.c.writes, r0 = kv.c.reads;
    const calls = accountsForTick(Object.values(keys), t0 + tick * 900e3).accts.length; maxCronCalls = Math.max(maxCronCalls, calls);
    await runTick(env, { cron: "*/15 * * * *", scheduledTime: t0 + tick * 900e3 });
    perTick.push({ w: kv.c.writes - w0, r: kv.c.reads - r0 }); }
  const states = JSON.parse(kv.m.get("st:acct0"));
  return { accounts: N, sites: N * sites, ticks, shards: accountsForTick(Object.values(keys), 0).shards, kv_writes_day: kv.c.writes, kv_reads_day: kv.c.reads,
    kv_writes_tick_max: Math.max(...perTick.map(x => x.w)), kv_writes_tick_steady: perTick[Math.min(10, perTick.length - 1)].w,
    max_subrequests_per_site_invocation: maxSiteSub, site_budget: SUBREQUEST_BUDGET, max_binding_calls_per_cron_invocation: maxCronCalls,
    max_binding_calls_per_account_invocation: maxAcctCalls, cpu_ms_per_site_check_max: +cpuMax.toFixed(2), cpu_ms_per_site_check_p95: +cpus.sort((x, y) => x - y)[Math.floor(cpus.length * 0.95)].toFixed(2), cpu_ms_per_site_check_avg: +(cpuSum / checks).toFixed(2),
    sample_results: Object.fromEntries(Object.entries(states).map(([u, s]) => [u.split("-")[1].split(".")[0], s.lastResult + (s.last.problems.length ? " " + s.last.problems.join(",") : "")])) };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const log = console.log; console.log = () => {};
  const out = []; for (const n of (process.argv.slice(2).length ? process.argv.slice(2) : [1, 5, 10, 20, 40]).map(Number)) out.push(await simulate(n));
  log(JSON.stringify(out, null, 1));
}
