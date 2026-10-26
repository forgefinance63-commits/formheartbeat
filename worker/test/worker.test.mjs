import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateUrlSyntax, validateUrl, safeFetch, isPrivateIp } from "../src/validate.js";
import { analyze, check, restClass, updateBaseline, detectChallenge } from "../src/check.js";
import { evaluate } from "../src/alerting.js";
import { createMailer } from "../src/email.js";
import { handle, MAX_TARGETS } from "../src/index.js";
import { sha256Hex } from "../src/auth.js";

const fx = n => readFileSync(new URL(`../../tests/fixtures/${n}.html`, import.meta.url), "utf8");
const publicDNS = async () => ["93.184.216.34"];
function mockFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => { calls.push({ url, method: opts.method || "GET", redirect: opts.redirect });
    const r = routes[url] ?? routes["*"]; if (!r) return new Response("nf", { status: 404 });
    return typeof r === "function" ? r(url, opts) : new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers }); };
  f.calls = calls; return f;
}
function memKV() { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) }; }

// ---------- SSRF ----------
test("SSRF: syntactic blocks", () => {
  const bad = {
    "http://example.com/": "https_only", "ftp://example.com/": "https_only", "file:///etc/passwd": "https_only",
    "https://127.0.0.1/": "private_ip", "https://10.0.0.5/": "private_ip", "https://192.168.1.1/": "private_ip",
    "https://172.16.3.4/": "private_ip", "https://169.254.169.254/latest/meta-data/": "private_ip",
    "https://[::1]/": "private_ip", "https://[fd00::1]/": "private_ip", "https://[fe80::1]/": "private_ip",
    "https://[::ffff:127.0.0.1]/": "private_ip", "https://100.64.0.1/": "private_ip", "https://0.0.0.0/": "private_ip",
    "https://8.8.8.8/": "ip_literal_not_allowed", "https://localhost/": "non_public_hostname",
    "https://foo.localhost/": "non_public_hostname", "https://metadata.google.internal/": "non_public_hostname",
    "https://printer.local/": "non_public_hostname", "https://intranet/": "non_public_hostname",
    "https://example.com:8443/": "port_not_allowed", "https://example.com:22/": "port_not_allowed",
    "https://user:pw@example.com/": "userinfo_not_allowed", "https://2130706433/": "private_ip",
    "https://0x7f000001/": "private_ip", "not a url": "unparseable",
  };
  for (const [u, reason] of Object.entries(bad)) {
    const r = validateUrlSyntax(u); assert.equal(r.ok, false, u);
    if (!["https://2130706433/", "https://0x7f000001/"].includes(u)) assert.equal(r.reason, reason, u);
  }
  assert.equal(validateUrlSyntax("https://example.com/contact/").ok, true);
  assert.equal(validateUrlSyntax("https://example.com:443/").ok, true);
  assert.equal(validateUrlSyntax("https://x.com/" + "a".repeat(3000)).ok, false);
});
test("SSRF: DNS rebinding to private IP is blocked", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd12::3", "192.168.0.10"]) {
    const r = await validateUrl("https://evil.example.com/", { resolve: async () => ["93.184.216.34", ip] });
    assert.deepEqual([r.ok, r.reason], [false, "resolves_to_private_ip"], ip);
  }
  assert.equal((await validateUrl("https://nx.example.com/", { resolve: async () => [] })).reason, "dns_no_records");
  assert.equal((await validateUrl("https://ok.example.com/", { resolve: publicDNS })).ok, true);
});
test("SSRF: redirect to private range / http is blocked and never fetched", async () => {
  const f = mockFetch({
    "https://a.example.com/": { status: 302, headers: { location: "https://169.254.169.254/latest/" } },
    "https://b.example.com/": { status: 301, headers: { location: "http://b.example.com/" } },
    "https://c.example.com/": { status: 302, headers: { location: "https://internal.corp/" } },
  });
  for (const [u, why] of [["https://a.example.com/", "blocked:private_ip"], ["https://b.example.com/", "blocked:https_only"], ["https://c.example.com/", "blocked:non_public_hostname"]]) {
    const r = await safeFetch(u, { fetchImpl: f, resolve: publicDNS }); assert.equal(r.error, why);
  }
  assert.ok(f.calls.every(c => c.redirect === "manual"));
  assert.ok(!f.calls.some(c => /169\.254|internal\.corp|http:\/\//.test(c.url)));
});
test("SSRF: redirect loop capped; size cap; private-resolving redirect target", async () => {
  const loop = mockFetch({ "*": { status: 302, headers: { location: "https://loop.example.com/" } } });
  assert.equal((await safeFetch("https://loop.example.com/", { fetchImpl: loop, resolve: publicDNS })).error, "too_many_redirects");
  const big = mockFetch({ "*": { body: "x".repeat(1_100_000) } });
  assert.equal((await safeFetch("https://big.example.com/", { fetchImpl: big, resolve: publicDNS })).error, "too_large");
  const f = mockFetch({ "https://a.example.com/": { status: 302, headers: { location: "https://rebind.example.com/" } } });
  const resolve = async h => h === "rebind.example.com" ? ["10.0.0.1"] : ["93.184.216.34"];
  assert.equal((await safeFetch("https://a.example.com/", { fetchImpl: f, resolve })).error, "blocked:resolves_to_private_ip");
});
test("isPrivateIp sanity", () => {
  assert.equal(isPrivateIp("93.184.216.34"), false); assert.equal(isPrivateIp("2606:4700::1111"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false); assert.equal(isPrivateIp("172.31.255.255"), true);
});

// ---------- CF7 checks ----------
const site = (rest, html = fx("present")) => mockFetch({
  "https://s.example.com/contact/": { body: html },
  "*": (url) => url.includes("contact-form-7/v1") ? new Response("{}", { status: rest }) : new Response("js", { status: 200 }),
});
test("analyze fixtures", () => {
  assert.ok(analyze(fx("present")).forms === 1); assert.equal(analyze(fx("missing")).forms, 0);
});
test("REST classification: 200 OK, 401/403 WARN, 404 FAIL, baseline change FAIL", async () => {
  assert.deepEqual([200, 401, 403, 404, 500].map(restClass), ["reachable", "protected", "protected", "broken", "broken"]);
  const o = s => ({ fetchImpl: site(s), resolve: publicDNS });
  assert.equal((await check("https://s.example.com/contact/", o(200))).result, "OK");
  assert.equal((await check("https://s.example.com/contact/", o(403))).result, "WARN");
  assert.equal((await check("https://s.example.com/contact/", o(401))).result, "WARN");
  assert.equal((await check("https://s.example.com/contact/", o(404))).result, "FAIL");
  const ch = await check("https://s.example.com/contact/", { ...o(403), baseline: { rest_class: "reachable" } });
  assert.equal(ch.result, "FAIL"); assert.ok(ch.problems.includes("rest_baseline_changed:reachable->protected"));
  assert.equal((await check("https://s.example.com/contact/", { ...o(403), baseline: { rest_class: "protected" } })).result, "WARN");
  const miss = await check("https://s.example.com/contact/", { fetchImpl: site(200, fx("missing")), resolve: publicDNS });
  assert.deepEqual([miss.result, miss.problems], ["FAIL", ["contact_form_missing"]]);
  const f = site(200); await check("https://s.example.com/contact/", { fetchImpl: f, resolve: publicDNS });
  assert.ok(f.calls.every(c => c.method === "GET" || c.method === "HEAD"), "never POST");
});

// ---------- Alerting ----------
test("alerting: 2 consecutive fails, dedupe, recovery, WARN is not fail", () => {
  const F = { result: "FAIL", problems: ["cf7_form_missing"], url: "u" }, OK = { result: "OK", problems: [], url: "u" }, W = { result: "WARN", problems: [], url: "u" };
  let s = null, a;
  ({ state: s, alert: a } = evaluate(s, F)); assert.equal(a, null);
  ({ state: s, alert: a } = evaluate(s, F)); assert.equal(a.type, "down");
  ({ state: s, alert: a } = evaluate(s, F)); assert.equal(a, null, "deduped");
  ({ state: s, alert: a } = evaluate(s, { ...F, problems: ["page_status:500"] })); assert.equal(a.type, "down", "new problem re-alerts");
  ({ state: s, alert: a } = evaluate(s, OK)); assert.equal(a.type, "recovered");
  ({ state: s, alert: a } = evaluate(s, OK)); assert.equal(a, null);
  ({ state: s, alert: a } = evaluate(s, F)); ({ state: s, alert: a } = evaluate(s, W)); assert.equal(a, null); assert.equal(s.consecutiveFails, 0);
  ({ state: s, alert: a } = evaluate(s, F)); assert.equal(a, null, "flap does not alert");
});
test("email: disabled by default; provider called via mock when enabled", async () => {
  const f = mockFetch({ "*": { status: 200 } });
  const off = createMailer({}, f); assert.equal(off.enabled, false);
  assert.deepEqual(await off.send("a@b.co", { type: "recovered", url: "u" }), { skipped: "alerts_disabled" }); assert.equal(f.calls.length, 0);
  const on = createMailer({ ALERTS_ENABLED: "true", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "test", ALERT_FROM: "x@y.co" }, f);
  await on.send("a@b.co", { type: "down", url: "u", problems: ["p"] });
  assert.equal(f.calls[0].url, "https://api.resend.com/emails");
  const mc = createMailer({ ALERTS_ENABLED: "true", EMAIL_PROVIDER: "mailchannels", ALERT_FROM: "x@y.co" }, f);
  await mc.send("a@b.co", { type: "recovered", url: "u" }); assert.equal(f.calls[1].url, "https://api.mailchannels.net/tx/v1/send");
});

// ---------- API auth / limits ----------
test("API: auth required, max targets, rate limit, URL validation", async () => {
  const key = "k".repeat(32); const env = { KV: memKV(), API_KEYS: JSON.stringify({ [await sha256Hex(key)]: "acct1" }) };
  const req = (m, p, body, k = key) => new Request("https://w.example/" + p, { method: m, headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  assert.equal((await handle(new Request("https://w.example/v1/check", { method: "POST" }), env)).status, 401);
  assert.equal((await handle(req("POST", "v1/check", null, "x".repeat(32)), env)).status, 401);
  assert.equal((await handle(req("POST", "v1/targets", { url: "https://169.254.169.254/" }), env, { resolve: publicDNS })).status, 400);
  assert.equal((await handle(req("POST", "v1/targets", { url: "https://rebind.example.com/" }), env, { resolve: async () => ["127.0.0.1"] })).status, 400);
  for (let i = 0; i < MAX_TARGETS; i++) assert.equal((await handle(req("POST", "v1/targets", { url: `https://s${i}.example.com/` }), env, { resolve: publicDNS })).status, 201);
  assert.equal((await handle(req("POST", "v1/targets", { url: "https://s9.example.com/" }), env, { resolve: publicDNS })).status, 403);
  const deps = { resolve: publicDNS, fetchImpl: mockFetch({ "*": { body: fx("present") } }) };
  let codes = []; for (let i = 0; i < 7; i++) codes.push((await handle(req("POST", "v1/check"), env, deps)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429]);
  const stored = [...env.KV.m.entries()].filter(([k]) => k.startsWith("state:")).map(([, v]) => v).join("");
  assert.ok(!stored.includes("<form"), "no HTML stored");
});

// ---------- multi-plugin + bot challenge ----------
const site2 = (html, { status = 200, asset = 200, ajax = 400 } = {}) => mockFetch({
  "https://s.example.com/contact/": { body: html, status },
  "*": (url) => url.includes("admin-ajax") ? new Response("0", { status: ajax }) : url.includes("contact-form-7/v1") ? new Response("{}", { status: 200 }) : new Response("js", { status: asset }),
});
const C = "https://s.example.com/contact/";
test("detects WPForms/Gravity/Elementor/Ninja/Fluent/generic, assets checked, GET/HEAD only", async () => {
  for (const n of ["wpforms", "gravity", "elementor", "ninja", "fluent", "generic"]) {
    const f = site2(fx(n)); const r = await check(C, { fetchImpl: f, resolve: publicDNS });
    assert.deepEqual([r.plugins, r.result], [[n], "OK"], n);
    assert.ok(f.calls.every(c => c.method === "GET" || c.method === "HEAD"), "never POST");
    if (n !== "generic") assert.ok((await check(C, { fetchImpl: site2(fx(n), { asset: 404 }), resolve: publicDNS })).problems.includes(`${n}:script_status:404`), n);
  }
  assert.equal((await check(C, { fetchImpl: site2(fx("wpforms"), { ajax: 403 }), resolve: publicDNS })).result, "WARN");
});
test("bot challenges: WARN never FAIL; FAIL only when persistent and changed from verified baseline", async () => {
  for (const [f, st, v] of [["ch_sgcaptcha", 202, "siteground_sgcaptcha"], ["ch_cloudflare", 403, "cloudflare"], ["ch_sucuri", 403, "sucuri"], ["ch_generic", 202, "generic"]]) {
    const r = await check(C, { fetchImpl: site2(fx(f), { status: st }), resolve: publicDNS });
    assert.deepEqual([r.result, r.challenge, r.problems], ["WARN", v, []], f);
  }
  assert.equal(detectChallenge(200, fx("cf_turnstile_ok")), null);
  assert.equal(detectChallenge(403, "<html>Forbidden</html>"), null);
  let b = updateBaseline(null, await check(C, { fetchImpl: site2(fx("gravity")), resolve: publicDNS }));
  const seq = [];
  for (let i = 0; i < 3; i++) { const r = await check(C, { fetchImpl: site2(fx("ch_sgcaptcha"), { status: 202 }), resolve: publicDNS, baseline: b }); b = updateBaseline(b, r); seq.push(r.result); }
  assert.deepEqual(seq, ["WARN", "WARN", "FAIL"]);
  let nb = null;
  for (let i = 0; i < 5; i++) { const r = await check(C, { fetchImpl: site2(fx("ch_cloudflare"), { status: 403 }), resolve: publicDNS, baseline: nb }); nb = updateBaseline(nb, r); assert.equal(r.result, "WARN"); }
});
