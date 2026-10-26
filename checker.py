#!/usr/bin/env python3
"""FormHeartbeat checker v0.3: external, read-only check of WordPress contact forms
(CF7, WPForms, Gravity Forms, Elementor Forms, Ninja Forms, Fluent Forms, Formidable, generic <form> with email field).
Only GET/HEAD requests. Never submits a form. Not proof that a submission works or a lead is delivered."""
import json, re, sys, time, datetime, urllib.request, urllib.error
from urllib.parse import urljoin, urlparse

UA = "FormHeartbeat/0.3 (+uptime check; read-only; never submits forms)"
TIMEOUT = 20
CHALLENGE_PERSIST = 3  # consecutive challenged checks on a previously verified site -> monitoring_problem (operator alert, not customer FAIL)
# Result states: OK (all checks inside defined coverage passed), FAIL (detected failure), UNVERIFIABLE (blocked / protected / cannot verify).
# Plugins with documented real-site accuracy (evidence/plugin-validation.md). Others are detected but EXPERIMENTAL.
VALIDATED = {"wpforms", "gravity", "elementor"}  # see evidence/plugin-validation.md

# name: form marker, submit marker, JS asset marker, asset required?, endpoint kind, js-rendered?
PLUGINS = {
    "cf7":        dict(form=r'<form[^>]*class="[^"]*wpcf7-form', submit=r'wpcf7-submit|type="submit"', asset=r'/contact-form-7/[^"\']*\.js', req=True, ep="cf7_rest"),
    "wpforms":    dict(form=r'<form[^>]*class="[^"]*wpforms-form', submit=r'wpforms-submit|type="submit"', asset=r'/wpforms(?:-lite)?/assets/js/[^"\']*\.js', req=True, ep="ajax"),
    "gravity":    dict(form=r'<form[^>]*id=[\'"]gform_\d+', submit=r'gform_button|type=[\'"]submit', asset=r'/gravityforms/js/[^"\']*\.js', req=False, ep=None),
    "elementor":  dict(form=r'<form[^>]*class="[^"]*elementor-form', submit=r'elementor-button|type="submit"', asset=r'/elementor(?:-pro)?/assets/js/[^"\']*\.js', req=True, ep="ajax"),
    "ninja":      dict(form=r'class="[^"]*nf-form-cont', submit=None, asset=r'/ninja-forms/[^"\']*\.js', req=True, ep="ajax"),  # form is JS-rendered
    "fluent":     dict(form=r'<form[^>]*class="[^"]*frm-fluent-form', submit=r'ff-btn-submit|type="submit"', asset=r'/fluentform/[^"\']*\.js', req=True, ep="ajax"),
    "formidable": dict(form=r'<form[^>]*class="[^"]*frm-show-form', submit=r'frm_button_submit|type="submit"', asset=r'/formidable/[^"\']*\.js', req=False, ep="ajax"),
}
OPTIMIZER_BUNDLE = r'/wp-content/(?:litespeed/js|cache/autoptimize|cache/min|cache/wpo-minify|cache/busting|uploads/siteground-optimizer-assets|et-cache)/[^"\']*\.js|data-rocket-src=|type="rocketlazyloadscript"'
ENDPOINTS = {"cf7_rest": "/wp-json/contact-form-7/v1", "ajax": "/wp-admin/admin-ajax.php"}
CHALLENGE = {  # vendor: (strong markers valid even on 200, weak markers valid only on 202/403/429/503)
    "siteground_sgcaptcha": ([r'sgcaptcha'], []),
    "cloudflare": ([r'<title>\s*Just a moment', r'cf-browser-verification', r'cf_chl_opt'], [r'challenge-platform', r'cf-ray', r'cloudflare']),
    "sucuri": ([r'sucuri_cloudproxy_js', r'Sucuri WebSite Firewall'], [r'sucuri']),
    "modsecurity": ([], [r'Mod_Security', r'ModSecurity']),
    "generic": ([], [r'captcha', r'verify (?:that )?you are (?:a )?human', r'bot protection', r'are you a robot']),
}
CONTACT_PATHS = ["/contact", "/contact-us", "/get-in-touch", "/quote"]
CONTACT_RE = re.compile(r'contact|get-in-touch|quote', re.I)

def http(url, method="GET", fetch=None):
    if fetch: return fetch(url, method)
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read(2_000_000).decode("utf-8", "replace") if method == "GET" else ""
            return {"status": r.status, "body": body, "ms": int((time.time()-t)*1000), "error": None, "url": r.geturl()}
    except urllib.error.HTTPError as e:
        try: body = e.read(200_000).decode("utf-8", "replace")
        except Exception: body = ""
        return {"status": e.code, "body": body, "ms": int((time.time()-t)*1000), "error": None, "url": url}
    except Exception as e:
        return {"status": None, "body": "", "ms": int((time.time()-t)*1000), "error": f"{type(e).__name__}: {e}", "url": url}

def detect_challenge(status, body):
    for vendor, (strong, weak) in CHALLENGE.items():
        if any(re.search(p, body, re.I) for p in strong) and (status != 200 or not detect_forms(body)): return vendor
        if status in (202, 403, 406, 429, 503) and any(re.search(p, body, re.I) for p in weak): return vendor
    return None

def _generic_forms(html):
    return [f for f in re.findall(r'<form\b.*?</form>', html, re.I | re.S)
            if re.search(r'type=["\']email|name=["\'][^"\']*e-?mail', f, re.I) and not any(re.search(s["form"], f, re.I) for s in PLUGINS.values())]

def detect_forms(html):
    found = {n: len(re.findall(s["form"], html, re.I)) for n, s in PLUGINS.items()}
    found = {k: v for k, v in found.items() if v}
    g = _generic_forms(html)
    if g: found["generic"] = len(g)
    return found

def analyze_html(html, base):
    forms = detect_forms(html)
    out = {"plugins": forms, "details": {}}
    for name in forms:
        if name == "generic":
            out["details"][name] = {"submit_control": any(re.search(r'type=["\']submit|<button', f, re.I) for f in _generic_forms(html)), "script_url": None}
            continue
        s = PLUGINS[name]
        m = re.search(r'(?:src|href)=["\']([^"\']*' + s["asset"] + r'[^"\']*)["\']', html, re.I)
        out["details"][name] = {
            "submit_control": None if s["submit"] is None else bool(re.search(s["submit"], html, re.I)),
            "script_url": urljoin(base, m.group(1).replace("&#038;", "&").replace("&amp;", "&")) if m else None}
    return out

def endpoint_class(kind, status):
    """GET-only probe. cf7_rest: 200 reachable. admin-ajax: 400 ('0', no action) or 200 = reachable.
    401/403 = protected (cannot verify). Anything else = broken."""
    if status == 200 or (kind == "ajax" and status == 400): return "reachable"
    if status in (401, 403): return "protected"
    return "broken"
rest_class = lambda status: endpoint_class("cf7_rest", status)  # backwards compatible

def check(url, fetch=None, baseline=None):
    baseline = baseline or {}
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    res = {"timestamp": ts, "url": url, "checks": {}, "problems": [], "warnings": [], "challenge": None}
    page = http(url, "GET", fetch)
    res["checks"]["page"] = {"status": page["status"], "ms": page["ms"], "error": page["error"]}
    ch = detect_challenge(page["status"], page.get("body") or "")
    if ch:
        res["challenge"] = ch
        res["warnings"].append(f"blocked_by_bot_protection:{ch} (cannot verify)")
        streak = baseline.get("challenge_streak", 0) + 1
        if baseline.get("verified") and streak >= CHALLENGE_PERSIST:
            res["monitoring_problem"] = f"bot_protection_persistent:{streak}_checks"  # our monitoring is blocked; NOT a form failure
        return _finish(res)
    if page["status"] != 200:
        res["problems"].append(f"page_status:{page['status'] or page['error']}")
        return _finish(res)
    a = analyze_html(page["body"], page.get("url") or url)
    res["checks"]["forms"] = a
    res["plugins"] = sorted(a["plugins"])
    if not a["plugins"]:
        res["problems"].append("contact_form_missing")
    if baseline.get("plugins") and set(baseline["plugins"]) - set(a["plugins"]):
        res["problems"].append("form_plugin_changed:" + ",".join(sorted(baseline["plugins"])) + "->" + (",".join(sorted(a["plugins"])) or "none"))
    p = urlparse(page.get("url") or url); root = f"{p.scheme}://{p.netloc}"
    res["endpoints"] = {}
    for name, d in a["details"].items():
        if d["submit_control"] is False: res["problems"].append(f"{name}:submit_control_missing")
        if name == "generic": continue
        s = PLUGINS[name]
        if d["script_url"]:
            r = http(d["script_url"], "HEAD", fetch)
            if r["status"] in (405, 403): r = http(d["script_url"], "GET", fetch)
            res["checks"][f"{name}_script"] = {"url": d["script_url"], "status": r["status"], "error": r["error"]}
            if r["status"] != 200: res["problems"].append(f"{name}:script_status:{r['status'] or r['error']}")
        elif s["req"] and re.search(OPTIMIZER_BUNDLE, page["body"], re.I):
            # JS combined by a cache/optimizer plugin: cannot attribute the plugin's asset -> cannot verify (not a failure)
            res["warnings"].append(f"{name}:asset_bundled_by_optimizer (cannot verify)")
        elif s["req"]:
            res["problems"].append(f"{name}:script_not_referenced")
        if s["ep"] and s["ep"] not in res["endpoints"]:
            r = http(root + ENDPOINTS[s["ep"]], "GET", fetch)
            cls = endpoint_class(s["ep"], r["status"])
            res["endpoints"][s["ep"]] = cls
            res["checks"][s["ep"]] = {"url": root + ENDPOINTS[s["ep"]], "status": r["status"], "class": cls}
            if cls == "protected": res["warnings"].append(f"{s['ep']}_protected:{r['status']} (cannot verify)")
            elif cls == "broken": res["problems"].append(f"{s['ep']}_status:{r['status'] or r['error']}")
            b = (baseline.get("endpoints") or {}).get(s["ep"])
            if b and b != cls: res["problems"].append(f"{s['ep']}_baseline_changed:{b}->{cls}")
    res["coverage"] = "validated" if res["plugins"] and set(res["plugins"]) <= VALIDATED else "experimental"
    if "cf7_rest" in res["endpoints"]: res["rest_class"] = res["endpoints"]["cf7_rest"]
    if baseline.get("rest_class") and res.get("rest_class") and baseline["rest_class"] != res["rest_class"] \
            and not any(x.startswith("cf7_rest_baseline") for x in res["problems"]):
        res["problems"].append(f"rest_baseline_changed:{baseline['rest_class']}->{res['rest_class']}")
    return _finish(res)

def _finish(res):
    res["result"] = "FAIL" if res["problems"] else ("UNVERIFIABLE" if res["warnings"] else "OK")
    return res

def update_baseline(baseline, res):
    """Baseline = what a verified (non-challenged) check looked like + consecutive-challenge streak."""
    b = dict(baseline or {})
    if res.get("challenge"):
        b["challenge_streak"] = b.get("challenge_streak", 0) + 1
        return b
    b["challenge_streak"] = 0
    if res["result"] in ("OK", "UNVERIFIABLE") and res.get("plugins") and not b.get("verified"):
        b.update(verified=True, plugins=res["plugins"], endpoints=res.get("endpoints", {}), set=res["timestamp"])
        if res.get("rest_class"): b["rest_class"] = res["rest_class"]
    return b

def candidate_pages(home_url, html):
    p = urlparse(home_url); root = f"{p.scheme}://{p.netloc}"; host = p.netloc.replace("www.", "")
    c = [home_url]
    for h in re.findall(r'href=["\']([^"\'#]+)["\']', html, re.I):
        u = urljoin(home_url, h); q = urlparse(u)
        if q.netloc.replace("www.", "") == host and CONTACT_RE.search(q.path) and not re.search(r'\.(pdf|jpg|png|js|css)$', q.path, re.I):
            c.append(f"{q.scheme}://{q.netloc}{q.path}")
    c += [root + x + "/" for x in CONTACT_PATHS]
    seen, out = set(), []
    for u in c:
        k = u.rstrip("/").lower()
        if k not in seen: seen.add(k); out.append(u)
    return out[:10]

def scan_site(home_url, fetch=None):
    """Discovery: homepage + every contact/get-in-touch/quote link + standard paths. 404s are skipped."""
    home = http(home_url, "GET", fetch)
    pages = []
    for u in candidate_pages(home.get("url") or home_url, home.get("body") or ""):
        r = check(u, fetch)
        if r["checks"]["page"]["status"] == 404: continue
        pages.append(r)
    with_form = [r for r in pages if r.get("plugins")]
    return {"site": home_url, "pages": pages, "form_pages": [r["url"] for r in with_form],
            "plugins": sorted({p for r in with_form for p in r["plugins"]}),
            "challenged": any(r["challenge"] for r in pages)}

def main(argv):
    if len(argv) < 2: print("usage: checker.py [--scan] URL [URL...]"); return 2
    scan = argv[1] == "--scan"; rc = 0
    for u in argv[2 if scan else 1:]:
        r = scan_site(u) if scan else check(u)
        print(json.dumps(r, indent=2))
        if not scan:
            with open("logs/checks.log", "a") as f: f.write(json.dumps(r) + "\n")
            rc |= r["result"] == "FAIL"
    return rc

if __name__ == "__main__": sys.exit(main(sys.argv))
