// FormHeartbeat Worker (NOT deployed). Authenticated API only; no public trigger.
import { check, updateBaseline } from "./check.js";
import { validateUrl } from "./validate.js";
import { evaluate } from "./alerting.js";
import { createMailer } from "./email.js";
import { authenticate, rateLimit, sha256Hex } from "./auth.js";
export const MAX_TARGETS = 5, MANUAL_CHECKS_PER_HOUR = 6, WRITES_PER_HOUR = 20;
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
  if (alert && t.alert_email) await createMailer(env, deps.fetchImpl).send(t.alert_email, alert);
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
  if (req.method === "POST" && pathname === "/v1/check") {
    if (!(await rateLimit(env.KV, acct, "check", MANUAL_CHECKS_PER_HOUR, 3600))) return j({ error: "rate_limited" }, 429);
    return j((await runAccount(env, acct, deps)).map(x => x.result));
  }
  return j({ error: "not_found" }, 404);
}
export default {
  async fetch(req, env) { return handle(req, env); },
  async scheduled(_e, env, ctx) {
    const accts = Object.values(JSON.parse(env.API_KEYS || "{}"));
    ctx.waitUntil(Promise.all([...new Set(accts)].map(a => runAccount(env, a))));
  },
};
