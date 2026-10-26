#!/usr/bin/env python3
"""FormHeartbeat checker: external, read-only check of a WordPress Contact Form 7 page.
Single GET of the page, HEAD/GET of the CF7 script and REST base. Never submits forms."""
import json, re, sys, time, datetime, urllib.request, urllib.error
from urllib.parse import urljoin, urlparse

UA = "FormHeartbeat/0.1 (+uptime check; read-only; contact: owner)"
TIMEOUT = 20

def http(url, method="GET", fetch=None):
    if fetch: return fetch(url, method)
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read(2_000_000).decode("utf-8", "replace") if method == "GET" else ""
            return {"status": r.status, "body": body, "ms": int((time.time()-t)*1000), "error": None}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "body": "", "ms": int((time.time()-t)*1000), "error": None}
    except Exception as e:
        return {"status": None, "body": "", "ms": int((time.time()-t)*1000), "error": f"{type(e).__name__}: {e}"}

def analyze_html(html, base):
    forms = re.findall(r'<form[^>]*class="[^"]*wpcf7-form[^"]*"[^>]*>', html, re.I)
    wrapper = bool(re.search(r'class="[^"]*\bwpcf7\b', html, re.I))
    has_submit = bool(re.search(r'wpcf7-submit|<input[^>]+type="submit"', html, re.I))
    m = re.search(r'<script[^>]+src="([^"]*contact-form-7[^"]*\.js[^"]*)"', html, re.I)
    script = urljoin(base, m.group(1).replace("&#038;", "&").replace("&amp;", "&")) if m else None
    actions = re.findall(r'<form[^>]*class="[^"]*wpcf7-form[^"]*"[^>]*action="([^"]*)"', html, re.I) or \
              re.findall(r'<form[^>]*action="([^"]*)"[^>]*class="[^"]*wpcf7-form', html, re.I)
    return {"cf7_wrapper": wrapper, "cf7_form_count": len(forms), "submit_control": has_submit, "script_url": script}

def check(url, fetch=None, baseline=None):
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    res = {"timestamp": ts, "url": url, "checks": {}, "problems": [], "warnings": []}
    page = http(url, "GET", fetch)
    res["checks"]["page"] = {"status": page["status"], "ms": page["ms"], "error": page["error"]}
    if page["status"] != 200:
        res["problems"].append(f"page_status:{page['status'] or page['error']}")
        res["result"] = "FAIL"; return res
    a = analyze_html(page["body"], url)
    res["checks"]["cf7"] = a
    if a["cf7_form_count"] == 0:
        res["problems"].append("cf7_form_missing")
    elif not a["submit_control"]:
        res["problems"].append("submit_control_missing")
    if a["cf7_form_count"]:
        if a["script_url"]:
            s = http(a["script_url"], "HEAD", fetch)
            if s["status"] in (405, 403): s = http(a["script_url"], "GET", fetch)
            res["checks"]["script"] = {"url": a["script_url"], "status": s["status"], "error": s["error"]}
            if s["status"] != 200: res["problems"].append(f"script_status:{s['status'] or s['error']}")
        else:
            res["problems"].append("cf7_script_not_referenced")
        p = urlparse(url); rest = f"{p.scheme}://{p.netloc}/wp-json/contact-form-7/v1"
        r = http(rest, "GET", fetch)
        res["checks"]["rest_base"] = {"url": rest, "status": r["status"], "error": r["error"]}
        res["rest_class"] = rest_class(r["status"])
        if res["rest_class"] == "protected":
            res["warnings"].append(f"rest_endpoint_protected:{r['status']} (cannot verify)")
        elif res["rest_class"] != "reachable":
            res["problems"].append(f"rest_base_status:{r['status'] or r['error']}")
        if baseline and baseline.get("rest_class") and baseline["rest_class"] != res["rest_class"]:
            res["problems"].append(f"rest_baseline_changed:{baseline['rest_class']}->{res['rest_class']}")
    res["result"] = "FAIL" if res["problems"] else ("WARN" if res["warnings"] else "OK")
    return res

def rest_class(status):
    """200 = endpoint reachable; 401/403 = protected/blocked (cannot verify); else broken."""
    if status == 200: return "reachable"
    if status in (401, 403): return "protected"
    return "broken"

def main(argv):
    if len(argv) < 2: print("usage: checker.py URL [URL...]"); return 2
    rc = 0
    for u in argv[1:]:
        r = check(u)
        line = json.dumps(r)
        print(json.dumps(r, indent=2))
        with open("logs/checks.log", "a") as f: f.write(line + "\n")
        rc |= r["result"] == "FAIL"
    return rc

if __name__ == "__main__": sys.exit(main(sys.argv))
