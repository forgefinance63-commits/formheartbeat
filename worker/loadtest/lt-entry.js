// LOAD-TEST ONLY (formheartbeat-loadtest). Same code as production + an HTTP trigger that runs the cron tick body.
import { Runner as R0 } from "./entry.js";
import worker, { runTick } from "./index.js";
export class Runner extends R0 {
  async ping() { return 1; }
  async depth(n) { return n <= 1 ? 1 : 1 + (await this.env.RUNNER.depth(n - 1)); }
}
export default {
  scheduled: worker.scheduled,
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (req.headers.get("x-lt") === env.LT_KEY && u.pathname === "/__lt/fan") { const n = +u.searchParams.get("n"); const kv = +(u.searchParams.get("kv")||0); try { for (let i = 0; i < kv; i++) await env.KV.get("acct:lt01:targets"); const r = await Promise.all(Array.from({ length: n }, () => env.RUNNER.ping())); return Response.json({ fan: n, kv, ok: r.length }); } catch (e) { return Response.json({ fan: n, error: String(e) }); } }
    if (req.headers.get("x-lt") === env.LT_KEY && u.pathname === "/__lt/depth") { const n = +u.searchParams.get("n"); try { return Response.json({ depth: n, ok: await env.RUNNER.depth(n) }); } catch (e) { return Response.json({ depth: n, error: String(e).slice(0, 200) }); } }
    if (u.pathname !== "/__lt/tick" || req.headers.get("x-lt") !== env.LT_KEY) return new Response("nf", { status: 404 });
    const errs = []; const orig = console.log;
    console.log = (...a) => { const s = a.join(" "); if (/account_error|site_error/.test(s)) errs.push(s.slice(0, 300)); orig(...a); };
    const t0 = Date.now(); let entry, fatal = null;
    try { entry = await runTick(env, { scheduledTime: Date.now() }); } catch (e) { fatal = String(e); }
    console.log = orig;
    return Response.json({ entry, fatal, errors: errs.length, sample_errors: [...new Set(errs.map(e => e.replace(/lt\d+|\?lt=[^"]+/g, "*")))].slice(0, 3), ms: Date.now() - t0 });
  },
};
