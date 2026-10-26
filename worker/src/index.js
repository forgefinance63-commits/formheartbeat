// FormHeartbeat Worker (deployed to workers.dev, free plan; see evidence/worker-deploy.md). Authenticated API only; no public trigger.
import { check, updateBaseline } from "./check.js";
import { validateUrl } from "./validate.js";
import { evaluate } from "./alerting.js";
import { createMailer } from "./email.js";
import { authenticate, rateLimit, sha256Hex } from "./auth.js";
export const MAX_TARGETS = 10, MANUAL_CHECKS_PER_HOUR = 6, WRITES_PER_HOUR = 20;
const j = (o, s = 200) => Response.json(o, { status: s });

async function getTargets(kv, acct) { return JSON.parse((await kv.get(`acct:${acct}:targets`)) || "[]"); }
async function runOne(env, acct, t, deps = {}) {
  const id = await sha256Hex(t.url); const sk = `state:${acct}:${id}`;
  const prev = JSON.parse((await env.KV.get(sk)) || "null");
  const r = await check(t.url, { baseline: prev?.baseline, ...deps });
  const { state, alert } = evaluate(prev, r);
  state.baseline = updateBaseline(prev?.baseline, r);
  // persistent bot blocking = OUR monitoring problem (operator log, deduped), never a customer form-failure alert
  if (r.monitoring_problem && !prev?.monitoring_problem) console.log(JSON.stringify({ operator_alert: r.monitoring_problem, acct, url: t.url }));
  state.monitoring_problem = r.monitoring_problem || null;
  // minimal stored data: status fields only, no HTML
  state.last = { result: r.result, problems: r.problems, warnings: r.warnings, page_status: r.page_status, ts: r.ts };
  await env.KV.put(sk, JSON.stringify(state));
  console.log(JSON.stringify({ acct, url: t.url, result: r.result, problems: r.problems, warnings: r.warnings }));
  if (alert) { // alerts recorded in state/logs; email only if ALERTS_ENABLED and target has an address
    const log = JSON.parse((await env.KV.get(`alerts:${acct}`)) || "[]"); log.push({ ...alert, url: t.url, ts: r.ts }); 
    await env.KV.put(`alerts:${acct}`, JSON.stringify(log.slice(-50))); console.log(JSON.stringify({ alert_recorded: alert.type, acct, url: t.url }));
  }
  if (alert && t.alert_email) {
    const mailer = createMailer(env, deps.mailFetch || deps.fetchImpl);
    const sent = await mailer.send(t.alert_email, alert);
    console.log(JSON.stringify({ alert_delivery: sent.skipped || (sent.ok ? "sent" : "failed"), status: sent.status, acct, url: t.url }));
    if (mailer.enabled && !sent.ok) { // delivery failed: undo dedupe so the next run retries the alert
      state.alerted = alert.type === "recovered"; state.lastAlertKey = alert.type === "down" ? null : state.lastAlertKey;
      await env.KV.put(sk, JSON.stringify(state));
    }
    alert.delivery = sent;
  }
  return { result: r, alert };
}
export async function runAccount(env, acct, deps) {
  const out = []; for (const t of await getTargets(env.KV, acct)) out.push(await runOne(env, acct, t, deps)); return out;
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
    const out = []; for (const t of await getTargets(env.KV, acct)) out.push({ url: t.url, state: JSON.parse((await env.KV.get(`state:${acct}:${await sha256Hex(t.url)}`)) || "null") });
    const log = JSON.parse((await env.KV.get("cron:log")) || "[]");
    return j({ targets: out, alerts: JSON.parse((await env.KV.get(`alerts:${acct}`)) || "[]"), last_cron: JSON.parse((await env.KV.get("cron:last")) || "null"),
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
export async function recordCron(env, e, startedMs, finishedMs, results) {
  const entry = { scheduled: new Date(e.scheduledTime).toISOString(), started: new Date(startedMs).toISOString(), delay_ms: startedMs - e.scheduledTime, duration_ms: finishedMs - startedMs, n: results.length, results: results.map(x => x.result.result) };
  const log = JSON.parse((await env.KV.get("cron:log")) || "[]"); log.push(entry);
  await env.KV.put("cron:log", JSON.stringify(log.slice(-CRON_LOG_MAX)));
  await env.KV.put("cron:last", JSON.stringify({ cron: e.cron, scheduled_time: entry.scheduled, started: entry.started, finished: new Date(finishedMs).toISOString(), accounts: results.length, results: entry.results }));
  return entry;
}
export default {
  async fetch(req, env) { return handle(req, env); },
  async scheduled(e, env, ctx) {
    const accts = Object.values(JSON.parse(env.API_KEYS || "{}")); const started = Date.now();
    ctx.waitUntil(Promise.all([...new Set(accts)].map(a => runAccount(env, a))).then(r => recordCron(env, e, started, Date.now(), r.flat())));
  },
};
