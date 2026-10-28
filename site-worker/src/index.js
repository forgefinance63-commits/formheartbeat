// formheartbeat-site: static landing (Workers Static Assets) + two tiny endpoints. No cookies, no PII in analytics.
//   POST /api/e      cookie-less counter (page view / CTA click), daily aggregate, KV-write capped
//   POST /api/pilot  pilot request: validate, rate-limit, store privately in KV, notify owner via Brevo. No auto-provisioning.
//   GET  /api/stats  owner-only (Bearer STATS_KEY): daily counters + pilot request count
export const EVENTS = /^(pv|cta:[a-z0-9-]{1,24})$/;
export const ANALYTICS_WRITES_PER_DAY = 150; // shared 1,000 KV writes/day account budget; monitoring keeps priority
export const PILOT_PER_IP_PER_HOUR = 3, PILOT_PER_DAY = 25;
const j = (o, s = 200) => Response.json(o, { status: s, headers: { "cache-control": "no-store" } });
const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
async function sha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
const sameOrigin = (req) => { const o = req.headers.get("origin"); if (!o) return true; try { return new URL(o).host === new URL(req.url).host; } catch { return false; } };

export async function track(req, env, now = Date.now()) {
  if (!sameOrigin(req)) return new Response(null, { status: 204 });
  const ua = req.headers.get("user-agent") || ""; if (!ua || /bot|crawl|spider|headless|preview/i.test(ua)) return new Response(null, { status: 204 });
  let e; try { e = JSON.parse((await req.text()).slice(0, 200)).e; } catch { return new Response(null, { status: 204 }); }
  if (!EVENTS.test(e || "")) return new Response(null, { status: 204 });
  const k = `an:${day(now)}`; const d = JSON.parse((await env.SITE_KV.get(k)) || '{"w":0,"c":{}}');
  if (d.w >= ANALYTICS_WRITES_PER_DAY) return new Response(null, { status: 204 }); // capped: protects the shared KV write budget
  d.c[e] = (d.c[e] || 0) + 1; d.w++; if (d.w === ANALYTICS_WRITES_PER_DAY) d.capped = true;
  await env.SITE_KV.put(k, JSON.stringify(d), { expirationTtl: 400 * 86400 });
  return new Response(null, { status: 204 });
}

export function validatePilot(b) {
  const err = m => ({ ok: false, message: m });
  if (!b || typeof b !== "object") return err("Invalid request.");
  if (b.website) return { ok: false, spam: true, message: "Invalid request." }; // honeypot
  const agency = String(b.agency || "").trim(), email = String(b.email || "").trim().toLowerCase();
  if (agency.length < 2 || agency.length > 120) return err("Please enter your agency name.");
  if (!/^[^@\s<>]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/.test(email) || email.length > 254) return err("Please enter a valid email address.");
  const raw = (Array.isArray(b.sites) ? b.sites : String(b.sites || "").split(/[\s,]+/)).map(s => String(s).trim()).filter(Boolean);
  const sites = [...new Set(raw)];
  if (!sites.length) return err("Please add at least one contact page URL.");
  if (sites.length > 10) return err("The pilot covers up to 10 sites.");
  for (const s of sites) { let u; try { u = new URL(s); } catch { return err(`Not a valid URL: ${s.slice(0, 80)}`); }
    if (u.protocol !== "https:" || s.length > 300 || u.username || u.password) return err(`Please use full https:// URLs (${s.slice(0, 80)}).`); }
  if (b.consent !== "yes" && b.consent !== true) return err("Please tick the consent box.");
  return { ok: true, value: { agency, email, sites } };
}
async function counter(kv, key, limit, ttl) { const n = +(await kv.get(key)) || 0; if (n >= limit) return false; await kv.put(key, String(n + 1), { expirationTtl: ttl }); return true; }
const esc = s => s.replace(/[\r\n]+/g, " ").slice(0, 200);

export async function pilot(req, env, deps = {}, now = Date.now()) {
  if (!sameOrigin(req)) return j({ message: "Invalid origin." }, 403);
  if ((+req.headers.get("content-length") || 0) > 8192) return j({ message: "Too large." }, 413);
  const ct = req.headers.get("content-type") || ""; let b;
  try { b = ct.includes("application/json") ? JSON.parse((await req.text()).slice(0, 8192)) : Object.fromEntries(await req.formData()); } catch { return j({ message: "Invalid request." }, 400); }
  const v = validatePilot(b); if (!v.ok) return j({ message: v.message }, v.spam ? 400 : 422);
  const ip = req.headers.get("cf-connecting-ip") || "0"; const iph = (await sha(`${env.IP_SALT || ""}:${day(now)}:${ip}`)).slice(0, 16); // daily-rotating hash, raw IP never stored
  if (!(await counter(env.SITE_KV, `rl:pilot:${iph}:${Math.floor(now / 3600e3)}`, PILOT_PER_IP_PER_HOUR, 7200))) return j({ message: "Too many requests. Please try again later or email hello@getformheartbeat.com." }, 429);
  if (!(await counter(env.SITE_KV, `rl:pilot:day:${day(now)}`, PILOT_PER_DAY, 172800))) return j({ message: "We're receiving a lot of requests. Please email hello@getformheartbeat.com." }, 429);
  const id = `${new Date(now).toISOString().replace(/[-:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const rec = { id, ts: new Date(now).toISOString(), ...v.value, consent: true, status: "new" };
  await env.SITE_KV.put(`pilot:${id}`, JSON.stringify(rec)); // private KV, never in the repo
  let notified = false;
  if (env.BREVO_API_KEY && env.NOTIFY_TO && env.NOTIFY_FROM) {
    try {
      const r = await (deps.fetchImpl || fetch)("https://api.brevo.com/v3/smtp/email", { method: "POST",
        headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ sender: { email: env.NOTIFY_FROM, name: "FormHeartbeat pilot form" }, to: [{ email: env.NOTIFY_TO }], replyTo: { email: v.value.email },
          subject: `[Pilot request] ${esc(v.value.agency)} (${v.value.sites.length} site${v.value.sites.length > 1 ? "s" : ""})`,
          textContent: `New pilot request ${id}\n\nAgency: ${esc(v.value.agency)}\nEmail: ${v.value.email}\nSites:\n${v.value.sites.map(s => " - " + s).join("\n")}\nConsent: yes\n\nNothing was provisioned. Onboard manually: see PILOT_PLAYBOOK.md (scripts/onboard-agency.sh).`,
          tags: ["formheartbeat-pilot-request"] }) });
      notified = r.status >= 200 && r.status < 300;
    } catch {}
  }
  if (!notified) { rec.notify = "failed"; await env.SITE_KV.put(`pilot:${id}`, JSON.stringify(rec)); }
  console.log(JSON.stringify({ pilot_request: id, sites: v.value.sites.length, notified })); // no email/agency in logs
  if ((req.headers.get("accept") || "").includes("text/html") && !ct.includes("json")) return Response.redirect(new URL("/thanks.html", req.url).toString(), 303);
  return j({ ok: true, id }, 201);
}

export async function stats(req, env) {
  const h = req.headers.get("authorization") || ""; const key = env.STATS_KEY || "";
  if (!key || h.length !== key.length + 7) return j({ error: "unauthorized" }, 401);
  let x = 0; const want = `Bearer ${key}`; for (let i = 0; i < want.length; i++) x |= want.charCodeAt(i) ^ h.charCodeAt(i); if (x) return j({ error: "unauthorized" }, 401);
  const days = {}; for (const k of (await env.SITE_KV.list({ prefix: "an:" })).keys) days[k.name.slice(3)] = JSON.parse(await env.SITE_KV.get(k.name)).c;
  const pilots = (await env.SITE_KV.list({ prefix: "pilot:" })).keys.length;
  return j({ days, pilot_requests_total: pilots });
}

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/e" && req.method === "POST") return track(req, env);
    if (pathname === "/api/pilot" && req.method === "POST") return pilot(req, env);
    if (pathname === "/api/stats" && req.method === "GET") return stats(req, env);
    if (pathname.startsWith("/api/")) return j({ error: "not_found" }, 404);
    return env.ASSETS.fetch(req);
  },
};
