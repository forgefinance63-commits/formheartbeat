import test from "node:test"; import assert from "node:assert/strict";
import { track, pilot, stats, validatePilot, ANALYTICS_WRITES_PER_DAY } from "../src/index.js";
function kv() { const m = new Map(), c = { w: 0 }; return { m, c, get: async k => m.get(k) ?? null, put: async (k, v) => { c.w++; m.set(k, v); },
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }) }; }
const U = "https://getformheartbeat.com";
const ev = (e, h = {}) => new Request(`${U}/api/e`, { method: "POST", body: JSON.stringify({ e }), headers: { "user-agent": "Mozilla/5.0", origin: U, ...h } });
const good = { agency: "Acme Web", email: "Owner@Acme.co", sites: "https://a.example/contact/\nhttps://b.example/", consent: "yes" };
const pr = (b, h = {}) => new Request(`${U}/api/pilot`, { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json", origin: U, "cf-connecting-ip": "1.2.3.4", ...h } });
test("analytics: counts pv + cta, ignores bots/foreign origin/bad events, capped writes", async () => {
  const env = { SITE_KV: kv() }; const now = Date.parse("2026-10-28T10:00:00Z");
  await track(ev("pv"), env, now); await track(ev("cta:hero"), env, now); await track(ev("cta:hero"), env, now);
  await track(ev("pv", { "user-agent": "Googlebot" }), env, now); await track(ev("pv", { origin: "https://evil.example" }), env, now); await track(ev("<x>"), env, now);
  assert.deepEqual(JSON.parse(env.SITE_KV.m.get("an:2026-10-28")).c, { pv: 1, "cta:hero": 2 });
  for (let i = 0; i < 300; i++) await track(ev("pv"), env, now);
  assert.equal(env.SITE_KV.c.w, ANALYTICS_WRITES_PER_DAY, "KV writes capped per day");
});
test("pilot: validation", () => {
  assert.equal(validatePilot(good).ok, true); assert.equal(validatePilot(good).value.email, "owner@acme.co");
  assert.equal(validatePilot({ ...good, consent: "" }).ok, false);
  assert.equal(validatePilot({ ...good, sites: "http://a.example/" }).ok, false);
  assert.equal(validatePilot({ ...good, sites: Array.from({ length: 11 }, (_, i) => `https://s${i}.example/`).join("\n") }).ok, false);
  assert.equal(validatePilot({ ...good, email: "nope" }).ok, false);
  assert.equal(validatePilot({ ...good, website: "x" }).spam, true);
});
test("pilot: stores privately, notifies owner only via Brevo, rate-limits per IP", async () => {
  const sent = []; const fetchImpl = async (u, o) => { sent.push({ u, b: JSON.parse(o.body) }); return new Response("{}", { status: 201 }); };
  const env = { SITE_KV: kv(), BREVO_API_KEY: "k", NOTIFY_TO: "hello@getformheartbeat.com", NOTIFY_FROM: "alerts@getformheartbeat.com" };
  const r = await pilot(pr(good), env, { fetchImpl }); assert.equal(r.status, 201);
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].b.to, [{ email: "hello@getformheartbeat.com" }]); assert.equal(sent[0].b.replyTo.email, "owner@acme.co");
  const recs = [...env.SITE_KV.m.entries()].filter(([k]) => k.startsWith("pilot:")); assert.equal(recs.length, 1); assert.equal(JSON.parse(recs[0][1]).sites.length, 2);
  assert.ok(![...env.SITE_KV.m.keys()].some(k => k.includes("1.2.3.4")), "raw IP not stored");
  const codes = []; for (let i = 0; i < 3; i++) codes.push((await pilot(pr(good), env, { fetchImpl })).status); assert.deepEqual(codes, [201, 201, 429]);
  assert.equal((await pilot(pr(good, { origin: "https://evil.example" }), env, { fetchImpl })).status, 403);
  assert.equal((await pilot(pr({ ...good, consent: "no" }), env, { fetchImpl })).status, 422);
});
test("stats: owner key required", async () => {
  const env = { SITE_KV: kv(), STATS_KEY: "s".repeat(32) };
  assert.equal((await stats(new Request(`${U}/api/stats`), env)).status, 401);
  assert.equal((await stats(new Request(`${U}/api/stats`, { headers: { authorization: "Bearer " + "x".repeat(32) } }), env)).status, 401);
  assert.equal((await stats(new Request(`${U}/api/stats`, { headers: { authorization: "Bearer " + "s".repeat(32) } }), env)).status, 200);
});
