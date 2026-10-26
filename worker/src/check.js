// Plugin-agnostic WordPress contact-form check (mirrors checker.py). GET/HEAD only; never submits.
import { safeFetch } from "./validate.js";
const UA = "FormHeartbeat/0.3 (+uptime check; read-only; never submits forms)";
export const CHALLENGE_PERSIST = 3;
export const PLUGINS = {
  cf7:        { form: /<form[^>]*class="[^"]*wpcf7-form/gi, submit: /wpcf7-submit|type="submit"/i, asset: "/contact-form-7/[^\"']*\\.js", req: true, ep: "cf7_rest" },
  wpforms:    { form: /<form[^>]*class="[^"]*wpforms-form/gi, submit: /wpforms-submit|type="submit"/i, asset: "/wpforms(?:-lite)?/assets/js/[^\"']*\\.js", req: true, ep: "ajax" },
  gravity:    { form: /<form[^>]*id=['"]gform_\d+/gi, submit: /gform_button|type=['"]submit/i, asset: "/gravityforms/js/[^\"']*\\.js", req: false, ep: null },
  elementor:  { form: /<form[^>]*class="[^"]*elementor-form/gi, submit: /elementor-button|type="submit"/i, asset: "/elementor-pro/assets/js/[^\"']*\\.js", req: true, ep: "ajax" },
  ninja:      { form: /class="[^"]*nf-form-cont/gi, submit: null, asset: "/ninja-forms/[^\"']*\\.js", req: true, ep: "ajax" },
  fluent:     { form: /<form[^>]*class="[^"]*frm-fluent-form/gi, submit: /ff-btn-submit|type="submit"/i, asset: "/fluentform/[^\"']*\\.js", req: true, ep: "ajax" },
  formidable: { form: /<form[^>]*class="[^"]*frm-show-form/gi, submit: /frm_button_submit|type="submit"/i, asset: "/formidable/[^\"']*\\.js", req: false, ep: "ajax" },
};
const ENDPOINTS = { cf7_rest: "/wp-json/contact-form-7/v1", ajax: "/wp-admin/admin-ajax.php" };
const CHALLENGE = {
  siteground_sgcaptcha: [[/sgcaptcha/i], []],
  cloudflare: [[/<title>\s*Just a moment/i, /cf-browser-verification/i, /cf_chl_opt/i], [/challenge-platform/i, /cf-ray/i, /cloudflare/i]],
  sucuri: [[/sucuri_cloudproxy_js/i, /Sucuri WebSite Firewall/i], [/sucuri/i]],
  generic: [[], [/captcha/i, /verify (?:that )?you are (?:a )?human/i, /bot protection/i, /are you a robot/i]],
};
const genericForms = html => (html.match(/<form\b[\s\S]*?<\/form>/gi) || []).filter(f =>
  /type=["']email|name=["'][^"']*e-?mail/i.test(f) && !Object.values(PLUGINS).some(p => new RegExp(p.form.source, "i").test(f)));
export function detectForms(html) {
  const out = {};
  for (const [n, p] of Object.entries(PLUGINS)) { const c = (html.match(p.form) || []).length; if (c) out[n] = c; }
  const g = genericForms(html).length; if (g) out.generic = g;
  return out;
}
export function detectChallenge(status, body) {
  for (const [vendor, [strong, weak]] of Object.entries(CHALLENGE)) {
    if (strong.some(r => r.test(body)) && (status !== 200 || !Object.keys(detectForms(body)).length)) return vendor;
    if ([202, 403, 429, 503].includes(status) && weak.some(r => r.test(body))) return vendor;
  }
  return null;
}
export function analyze(html) {
  const plugins = detectForms(html), details = {};
  for (const n of Object.keys(plugins)) {
    if (n === "generic") { details[n] = { submit: genericForms(html).some(f => /type=["']submit|<button/i.test(f)), script: null }; continue; }
    const p = PLUGINS[n];
    const m = html.match(new RegExp(`(?:src|href)=["']([^"']*${p.asset}[^"']*)["']`, "i"));
    details[n] = { submit: p.submit ? p.submit.test(html) : null, script: m ? m[1].replace(/&#038;|&amp;/g, "&") : null };
  }
  return { plugins, details, forms: Object.values(plugins).reduce((a, b) => a + b, 0) };
}
/** GET-only probe. cf7_rest: 200 reachable; admin-ajax: 200/400 reachable; 401/403 protected (cannot verify); else broken. */
export function endpointClass(kind, status) {
  if (status === 200 || (kind === "ajax" && status === 400)) return "reachable";
  if (status === 401 || status === 403) return "protected";
  return "broken";
}
export const restClass = s => endpointClass("cf7_rest", s);
const finish = res => { res.result = res.problems.length ? "FAIL" : res.warnings.length ? "WARN" : "OK"; return res; };

/** Returns a minimal result object (no page bodies stored). */
export async function check(url, { baseline = null, fetchImpl, resolve } = {}) {
  const b = baseline || {};
  const o = { fetchImpl, resolve, ua: UA };
  const res = { ts: new Date().toISOString(), url, problems: [], warnings: [], challenge: null };
  const page = await safeFetch(url, o);
  res.page_status = page.status; res.page_ms = page.ms ?? null;
  const ch = page.error ? null : detectChallenge(page.status, page.body || "");
  if (ch) {
    res.challenge = ch; res.warnings.push(`blocked_by_bot_protection:${ch}`);
    const streak = (b.challenge_streak || 0) + 1;
    if (b.verified && streak >= CHALLENGE_PERSIST) res.problems.push(`bot_protection_persistent_changed:${streak}_checks`);
    return finish(res);
  }
  if (page.error) res.problems.push(`page_error:${page.error}`);
  else if (page.status !== 200) res.problems.push(`page_status:${page.status}`);
  if (res.problems.length) return finish(res);
  const a = analyze(page.body);
  res.plugins = Object.keys(a.plugins).sort(); res.forms = a.forms;
  if (!res.plugins.length) res.problems.push("contact_form_missing");
  if (b.plugins?.some(p => !res.plugins.includes(p))) res.problems.push(`form_plugin_changed:${[...b.plugins].sort()}->${res.plugins.join(",") || "none"}`);
  res.endpoints = {};
  for (const [n, d] of Object.entries(a.details)) {
    if (d.submit === false) res.problems.push(`${n}:submit_control_missing`);
    if (n === "generic") continue;
    const p = PLUGINS[n];
    if (d.script) {
      const s = await safeFetch(new URL(d.script, page.url).toString(), { ...o, method: "HEAD" });
      if (s.status !== 200) res.problems.push(`${n}:script_status:${s.error || s.status}`);
    } else if (p.req) res.problems.push(`${n}:script_not_referenced`);
    if (p.ep && !(p.ep in res.endpoints)) {
      const r = await safeFetch(new URL(ENDPOINTS[p.ep], page.url).toString(), o);
      const cls = endpointClass(p.ep, r.status); res.endpoints[p.ep] = cls;
      if (cls === "protected") res.warnings.push(`${p.ep}_protected:${r.status}`);
      else if (cls === "broken") res.problems.push(`${p.ep}_status:${r.error || r.status}`);
      const prev = b.endpoints?.[p.ep] ?? (p.ep === "cf7_rest" ? b.rest_class : undefined);
      if (prev && prev !== cls) res.problems.push(p.ep === "cf7_rest" ? `rest_baseline_changed:${prev}->${cls}` : `${p.ep}_baseline_changed:${prev}->${cls}`);
    }
  }
  if (res.endpoints.cf7_rest) res.rest_class = res.endpoints.cf7_rest;
  return finish(res);
}
export function updateBaseline(baseline, r) {
  const b = { ...(baseline || {}) };
  if (r.challenge) { b.challenge_streak = (b.challenge_streak || 0) + 1; return b; }
  b.challenge_streak = 0;
  if ((r.result === "OK" || r.result === "WARN") && r.plugins?.length && !b.verified)
    Object.assign(b, { verified: true, plugins: r.plugins, endpoints: r.endpoints, set: r.ts });
  return b;
}
