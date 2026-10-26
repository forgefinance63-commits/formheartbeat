// FormHeartbeat CF7 checker core as a Cloudflare Worker (ES module).
// Read-only: one GET of the page, GET of the CF7 script, GET of the REST base. Never submits forms.
const UA = "FormHeartbeat/0.1 (+uptime check; read-only; contact: owner)";

async function get(url, method = "GET") {
  const t = Date.now();
  try {
    const r = await fetch(url, { method, headers: { "User-Agent": UA }, redirect: "follow" });
    const body = method === "GET" ? await r.text() : "";
    return { status: r.status, ms: Date.now() - t, body, url: r.url };
  } catch (e) {
    return { status: 0, ms: Date.now() - t, body: "", error: String(e) };
  }
}

export function analyze(html) {
  const forms = (html.match(/<form[^>]*class="[^"]*wpcf7-form/g) || []).length;
  const submit = /wpcf7-submit/.test(html);
  const m = html.match(/(?:src|href)=["']([^"']*contact-form-7\/[^"']*\.js[^"']*)["']/);
  return { forms, submit, script: m ? m[1].replace(/&#038;|&amp;/g, "&") : null };
}

export async function check(url) {
  const res = { timestamp: new Date().toISOString(), url, problems: [] };
  const page = await get(url);
  res.page_status = page.status; res.page_ms = page.ms;
  if (page.status !== 200) res.problems.push(`page_status:${page.status}`);
  const a = analyze(page.body);
  res.cf7_form_count = a.forms; res.submit_control = a.submit;
  if (!a.forms) res.problems.push("cf7_form_missing");
  else if (!a.submit) res.problems.push("submit_control_missing");
  if (!a.script) { if (a.forms) res.problems.push("cf7_script_not_referenced"); }
  else {
    const s = new URL(a.script, page.url || url).toString();
    const sr = await get(s); res.script = s; res.script_status = sr.status;
    if (sr.status !== 200) res.problems.push(`script_status:${sr.status}`);
  }
  if (a.forms) {
    const rest = new URL("/wp-json/contact-form-7/v1", url).toString();
    const rr = await get(rest); res.rest_base_status = rr.status;
    if (![200, 401, 403].includes(rr.status)) res.problems.push(`rest_base_status:${rr.status}`);
  }
  res.result = res.problems.length ? "FAIL" : "OK";
  return res;
}

async function runAll(env) {
  const targets = (env.TARGETS || "").split(",").map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const u of targets) {
    const r = await check(u);
    console.log(JSON.stringify(r));
    if (env.CHECKS_KV) await env.CHECKS_KV.put(`check:${r.timestamp}:${u}`, JSON.stringify(r), { expirationTtl: 60 * 60 * 24 * 30 });
    if (env.CHECKS_DB) await env.CHECKS_DB.prepare("INSERT INTO checks (ts,url,result,json) VALUES (?,?,?,?)").bind(r.timestamp, u, r.result, JSON.stringify(r)).run();
    out.push(r);
  }
  return out;
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runAll(env)); },
  async fetch(req, env) {
    // Manual trigger for local dev only (wrangler dev): GET /run
    if (new URL(req.url).pathname === "/run") return Response.json(await runAll(env));
    return new Response("FormHeartbeat worker", { status: 200 });
  },
};
