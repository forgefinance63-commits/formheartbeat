import { safeFetch } from "./validate.js";
const UA = "FormHeartbeat/0.2 (+uptime check; read-only; never submits forms)";

export function analyze(html) {
  const forms = (html.match(/<form[^>]*class="[^"]*wpcf7-form/g) || []).length;
  const submit = /wpcf7-submit/.test(html);
  const m = html.match(/(?:src|href)=["']([^"']*contact-form-7\/[^"']*\.js[^"']*)["']/);
  return { forms, submit, script: m ? m[1].replace(/&#038;|&amp;/g, "&") : null };
}
/** 200 = reachable; 401/403 = protected (cannot verify); anything else = broken. */
export function restClass(status) {
  if (status === 200) return "reachable";
  if (status === 401 || status === 403) return "protected";
  return "broken";
}
/** Returns a minimal result object (no page bodies stored). */
export async function check(url, { baseline = null, fetchImpl, resolve } = {}) {
  const o = { fetchImpl, resolve, ua: UA };
  const res = { ts: new Date().toISOString(), url, problems: [], warnings: [] };
  const page = await safeFetch(url, o);
  res.page_status = page.status; res.page_ms = page.ms ?? null;
  if (page.error) res.problems.push(`page_error:${page.error}`);
  else if (page.status !== 200) res.problems.push(`page_status:${page.status}`);
  if (res.problems.length) { res.result = "FAIL"; return res; }
  const a = analyze(page.body);
  res.cf7_forms = a.forms;
  if (!a.forms) res.problems.push("cf7_form_missing");
  else if (!a.submit) res.problems.push("submit_control_missing");
  if (a.forms) {
    if (!a.script) res.problems.push("cf7_script_not_referenced");
    else {
      const s = await safeFetch(new URL(a.script, page.url).toString(), o);
      res.script_status = s.status;
      if (s.status !== 200) res.problems.push(`script_status:${s.error || s.status}`);
    }
    const rr = await safeFetch(new URL("/wp-json/contact-form-7/v1", page.url).toString(), o);
    res.rest_status = rr.status; res.rest_class = restClass(rr.status);
    if (res.rest_class === "protected") res.warnings.push(`rest_endpoint_protected:${rr.status}`);
    else if (res.rest_class === "broken") res.problems.push(`rest_base_status:${rr.error || rr.status}`);
    if (baseline?.rest_class && baseline.rest_class !== res.rest_class)
      res.problems.push(`rest_baseline_changed:${baseline.rest_class}->${res.rest_class}`);
  }
  res.result = res.problems.length ? "FAIL" : res.warnings.length ? "WARN" : "OK";
  return res;
}
