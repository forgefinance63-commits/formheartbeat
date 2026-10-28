// FormHeartbeat Worker (deployed to workers.dev, free plan; see evidence/worker-deploy.md). Authenticated API only; no public trigger.
import { check, updateBaseline, CHALLENGE_PERSIST } from "./check.js";
import { validateUrl, dohResolve } from "./validate.js";
import { evaluate, FAIL_THRESHOLD } from "./alerting.js";
import { createMailer } from "./email.js";
import { authenticate, rateLimit, sha256Hex } from "./auth.js";
export const MAX_TARGETS = 10, MANUAL_CHECKS_PER_HOUR = 6, WRITES_PER_HOUR = 20;
const j = (o, s = 200) => Response.json(o, { status: s });

async function getTargets(kv, acct) { return JSON.parse((await kv.get(`acct:${acct}:targets`)) || "[]"); }
export const SUBREQUEST_BUDGET = 45; // free plan: 50 external subrequests per invocation; keep 5 spare (alert email)
/** Per-invocation fetch counter + DNS memo. Over budget -> network_error -> transient/UNVERIFIABLE (honest, never FAIL). */
export function budgeted(deps = {}, budget = SUBREQUEST_BUDGET) {
  const f = deps.fetchImpl || ((...a) => fetch(...a)); const meter = { n: 0, budget };
  const fetchImpl = (...a) => (++meter.n > budget ? Promise.reject(new Error("subrequest_budget")) : f(...a));
  const base = deps.resolve || (h => dohResolve(h, fetchImpl)); const memo = new Map();
  const resolve = h => { if (!memo.has(h)) memo.set(h, base(h)); return memo.get(h); };
  return { ...deps, fetchImpl, resolve, meter };
}
const cap = (n, m) => Math.min(n || 0, m);
/** Fields that change every tick (timestamps, latency, uncapped counters) are NOT persisted, so an unchanged site causes no KV write. */
export function persistable(state, r, prev) {
  const s = { ...state }; delete s.lastTs;
  s.consecutiveFails = cap(s.consecutiveFails, FAIL_THRESHOLD);
  s.baseline = { ...s.baseline }; for (const k of ["challenge_streak", "unreachable_streak"]) if (k in s.baseline) s.baseline[k] = cap(s.baseline[k], CHALLENGE_PERSIST);
  s.since = prev && prev.lastResult === s.lastResult && prev.since ? prev.since : r.ts; // when the current result started
  s.last = { result: r.result, problems: r.problems, warnings: r.warnings, page_status: r.page_status };
  return s;
}
/** Checks ONE site. Runs in its own invocation when env.RUNNER (self service binding) exists -> own 50-subrequest + CPU budget. No KV access. */
export async function checkSite(env, acct, t, prev, deps = {}) {
  const d = budgeted(deps);
  const r = await check(t.url, { baseline: prev?.baseline, ...d });
  const { state, alert } = evaluate(prev, r);
  state.baseline = updateBaseline(prev?.baseline, r);
  if (r.monitoring_problem && !prev?.monitoring_problem) console.log(JSON.stringify({ operator_alert: r.monitoring_problem, acct, url: t.url }));
  state.monitoring_problem = r.monitoring_problem || null;
  console.log(JSON.stringify({ acct, url: t.url, result: r.result, problems: r.problems, warnings: r.warnings, subrequests: d.meter.n }));
  if (alert && t.alert_email) {
    const mailer = createMailer(env, deps.mailFetch || deps.fetchImpl);
    const sent = await mailer.send(t.alert_email, alert);
    console.log(JSON.stringify({ alert_delivery: sent.skipped || (sent.ok ? "sent" : "failed"), status: sent.status, acct, url: t.url }));
    if (mailer.enabled && !sent.ok) { state.alerted = alert.type === "recovered"; state.lastAlertKey = alert.type === "down" ? null : state.lastAlertKey; }
    alert.delivery = sent;
  }
  const result = { result: r.result, problems: r.problems, warnings: r.warnings, page_status: r.page_status, ts: r.ts, url: t.url, subrequests: d.meter.n };
  return { state: persistable(state, r, prev), alert, result };
}
const stateKey = acct => `st:${acct}`;
export async function loadStates(env, acct, targets) {
  const raw = await env.KV.get(stateKey(acct)); if (raw) return JSON.parse(raw);
  const m = {}; for (const t of targets) { const v = await env.KV.get(`state:${acct}:${await sha256Hex(t.url)}`); if (v) m[t.url] = JSON.parse(v); } // one-time migration from per-target keys
  return m;
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }
/** One account: 1-2 KV reads, at most 1 state write (only if something changed) + 1 alerts write (only if an alert fired). */
export async function runAccount(env, acct, deps = {}) {
  const targets = await getTargets(env.KV, acct); if (!targets.length) return [];
  const prevAll = await loadStates(env, acct, targets);
  const one = t => (env.RUNNER && !deps.fetchImpl) ? env.RUNNER.checkSite(acct, t, prevAll[t.url] || null) : checkSite(env, acct, t, prevAll[t.url] || null, deps);
  const outs = await pool(targets, 4, async t => { try { return await one(t); } catch (e) { console.log(JSON.stringify({ site_error: String(e), acct, url: t.url })); return null; } });
  const next = {}; const alerts = [];
  targets.forEach((t, i) => { const o = outs[i]; next[t.url] = o ? o.state : prevAll[t.url]; if (o?.alert) alerts.push({ ...o.alert, url: t.url, ts: o.result.ts }); });
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
  if (JSON.stringify(next) !== JSON.stringify(prevAll) || !(await env.KV.get(stateKey(acct)))) await env.KV.put(stateKey(acct), JSON.stringify(next));
  if (alerts.length) { const log = JSON.parse((await env.KV.get(`alerts:${acct}`)) || "[]"); log.push(...alerts);
    await env.KV.put(`alerts:${acct}`, JSON.stringify(log.slice(-50))); console.log(JSON.stringify({ alerts_recorded: alerts.length, acct })); }
  return outs.filter(Boolean).map(o => ({ result: o.result, alert: o.alert }));
}
export async function handle(req, env, deps = {}) {
  const acct = await authenticate(req, env);
  if (!acct) return j({ error: "unauthorized" }, 401);
  const { pathname } = new URL(req.url);
  if (req.method === "GET" && pathname === "/v1/targets") return j(await getTargets(env.KV, acct));
  if (req.method === "POST" && pathname === "/v1/targets") {
    if (!(await rateLimit(env.KV, acct, "write", WRITES_PER_HOUR, 3600))) return j({ error: "rate_limited" }, 429);
    const len = +req.headers.get("content-length") || 0; if (len > 4096) return j({ error: "too_large" }, 413);
    let b; try { b = await req.json(); } catch { return j({ error: "bad_json" }, 400); }
    const v = await validateUrl(b?.url, { resolve: deps.resolve }); if (!v.ok) return j({ error: v.reason }, 400);
    const ts = await getTargets(env.KV, acct);
    if (ts.length >= MAX_TARGETS) return j({ error: "max_targets" }, 403);
    if (b.alert_email && !/^[^@\s]{1,64}@[^@\s]{1,255}$/.test(b.alert_email)) return j({ error: "bad_email" }, 400);
    ts.push({ url: v.url.toString(), alert_email: b.alert_email || null });
    await env.KV.put(`acct:${acct}:targets`, JSON.stringify(ts)); return j({ ok: true, count: ts.length }, 201);
  }
  if (req.method === "GET" && pathname === "/v1/status") {
    const ts = await getTargets(env.KV, acct); const sts = await loadStates(env, acct, ts); const out = ts.map(t => ({ url: t.url, state: sts[t.url] || null }));
    const log = JSON.parse((await env.KV.get("cron:log")) || "[]");
    return j({ targets: out, alerts: JSON.parse((await env.KV.get(`alerts:${acct}`)) || "[]"), last_cron: log.at(-1) || null,
      cron_punctuality: summarize(log), cron_log: log.slice(-96), alerts_email: createMailer(env).enabled ? "enabled" : "disabled" });
  }
  if (req.method === "POST" && pathname === "/v1/check") {
    if (!(await rateLimit(env.KV, acct, "check", MANUAL_CHECKS_PER_HOUR, 3600))) return j({ error: "rate_limited" }, 429);
    return j((await runAccount(env, acct, deps)).map(x => x.result));
  }
  return j({ error: "not_found" }, 404);
}
export const CRON_LOG_MAX = 672; // ~7 days at */15
export function summarize(log) {
  if (!log.length) return { n: 0 };
  const d = log.map(e => e.delay_ms).sort((a, b) => a - b), q = p => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  let gaps = 0; for (let i = 1; i < log.length; i++) if (Date.parse(log[i].scheduled) - Date.parse(log[i - 1].scheduled) > 15 * 60e3 * 1.5) gaps++;
  return { n: log.length, first: log[0].scheduled, last: log.at(-1).scheduled, delay_ms_p50: q(0.5), delay_ms_p95: q(0.95), delay_ms_max: d.at(-1), missed_slot_gaps: gaps };
}
/** ONE KV write per tick: ring buffer (CRON_LOG_MAX) of compact entries; replaces cron:log + cron:last. */
export async function recordCron(env, e, startedMs, finishedMs, results, extra = {}) {
  const c = {}; for (const x of results) c[x.result.result] = (c[x.result.result] || 0) + 1;
  const entry = { scheduled: new Date(e.scheduledTime).toISOString(), started: new Date(startedMs).toISOString(), delay_ms: startedMs - e.scheduledTime, duration_ms: finishedMs - startedMs, n: results.length, counts: c, ...extra };
  const log = JSON.parse((await env.KV.get("cron:log")) || "[]"); log.push(entry);
  await env.KV.put("cron:log", JSON.stringify(log.slice(-CRON_LOG_MAX)));
  return entry;
}
export const MAX_ACCOUNTS_PER_TICK = 40; // each account = 1 service-binding call from the cron invocation (< 50); beyond this, accounts are sharded across ticks
export function accountsForTick(accts, scheduledTime, per = MAX_ACCOUNTS_PER_TICK) {
  const shards = Math.ceil(accts.length / per) || 1; const k = Math.floor(scheduledTime / 900e3) % shards;
  return { shards, shard: k, accts: accts.filter((_, i) => i % shards === k) };
}
export async function runTick(env, e, deps = {}) {
  const all = [...new Set(Object.values(JSON.parse(env.API_KEYS || "{}")))].sort(); const started = Date.now();
  const { shards, shard, accts } = accountsForTick(all, e.scheduledTime);
  const run = a => (env.RUNNER && !deps.fetchImpl) ? env.RUNNER.runAccount(a) : runAccount(env, a, deps);
  const r = await pool(accts, 6, async a => { try { return await run(a); } catch (err) { console.log(JSON.stringify({ account_error: String(err), acct: a })); return []; } });
  return recordCron(env, e, started, Date.now(), r.flat(), shards > 1 ? { shard: `${shard + 1}/${shards}` } : {});
}
export default {
  async fetch(req, env) { return handle(req, env); },
  async scheduled(e, env, ctx) {
    ctx.waitUntil(runTick(env, e));
  },
};
