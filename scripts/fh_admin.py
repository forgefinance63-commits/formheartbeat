#!/usr/bin/env python3
"""FormHeartbeat admin CLI (owner only). Secrets/keys are read from $FH_PRIVATE (default /workspace/private), never printed.
  onboard <account-slug> <alert-email> <url> [url ...]   create API key, add sites, run first check     (~1-2 min)
  test-alert <to-email>                                   send one clearly-labelled TEST alert via Brevo (owner approves recipient)
  requests                                                list pilot requests from the private site KV
  stats                                                   landing counters (page views / CTA clicks / requests)
  offboard <account-slug> [--pilot-id ID]                 revoke key, delete targets/state/alerts (+ pilot request)
Requires: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env, wrangler (site-worker/node_modules)."""
import json, os, secrets, subprocess, sys, time, urllib.request, hashlib, pathlib, re
PRIV = pathlib.Path(os.environ.get("FH_PRIVATE", "/workspace/private"))
ROOT = pathlib.Path(__file__).resolve().parent.parent
WR = str(ROOT / "site-worker/node_modules/.bin/wrangler")
API = "https://formheartbeat.formheartbeat.workers.dev"
MON_KV, SITE_KV = "9d8920a193474051be0b711049b51e70", "d107d6af88c64c7a902449ccfe4d7dea"
UA = {"User-Agent": "fh-admin/1"}

def call(method, path, key, body=None, base=API):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={**UA, "Authorization": f"Bearer {key}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")
def wr(*args, cwd="worker", stdin=None):
    return subprocess.run([WR, *args], cwd=ROOT / cwd, input=stdin, capture_output=True, text=True, check=True).stdout
def kv(*args, ns=MON_KV): return wr("kv", "key", *args, "--namespace-id", ns, "--remote")
def keys_file(): return PRIV / "api_keys_secret.json"
def put_api_keys(m):
    keys_file().write_text(json.dumps(m)); os.chmod(keys_file(), 0o600)
    wr("secret", "put", "API_KEYS", stdin=json.dumps(m))

def onboard(slug, email, *urls):
    t0 = time.time()
    if not re.fullmatch(r"[a-z0-9-]{3,40}", slug): sys.exit("slug: a-z 0-9 - (3-40 chars)")
    if not 1 <= len(urls) <= 10: sys.exit("1-10 urls")
    m = json.loads(keys_file().read_text())
    if slug in m.values(): sys.exit(f"account {slug} already exists")
    key = secrets.token_urlsafe(32); m[hashlib.sha256(key.encode()).hexdigest()] = slug
    d = PRIV / "agencies" / slug; d.mkdir(parents=True, exist_ok=True)
    (d / "api_key.txt").write_text(key); os.chmod(d / "api_key.txt", 0o600)
    put_api_keys(m); print(f"[1/3] API key created for {slug} (saved to {d}/api_key.txt, not printed)")
    for i in range(30):  # secret propagation
        if call("GET", "/v1/targets", key)[0] == 200: break
        time.sleep(3)
    for u in urls:
        s, r = call("POST", "/v1/targets", key, {"url": u, "alert_email": email}); print(f"[2/3] add {u}: {s} {r}")
    s, r = call("POST", "/v1/check", key); print(f"[3/3] first check: {s}")
    for x in r or []: print(f"   {x.get('result'):12} {x.get('url')}  {', '.join(x.get('problems') or []) or ''}")
    (d / "onboarded.json").write_text(json.dumps({"slug": slug, "alert_email": email, "urls": urls, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
    print(f"done in {time.time() - t0:.0f}s. Next: review results, then `test-alert {email}` once the owner approves.")

def test_alert(to):
    key = (PRIV / "brevo_api_key.txt").read_text().strip()
    body = {"sender": {"email": "alerts@getformheartbeat.com", "name": "FormHeartbeat"}, "to": [{"email": to}],
            "subject": "[FormHeartbeat] TEST alert - no action needed",
            "textContent": "This is a test of FormHeartbeat alert delivery, sent during pilot onboarding.\nIf a monitored contact page fails two consecutive checks, an alert like this one arrives from alerts@getformheartbeat.com.\nPlease reply if it landed in spam.",
            "tags": ["formheartbeat-test-alert"]}
    req = urllib.request.Request("https://api.brevo.com/v3/smtp/email", data=json.dumps(body).encode(), method="POST",
                                 headers={"api-key": key, "content-type": "application/json", "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r: print("brevo:", r.status)

def requests_():
    names = [k["name"] for k in json.loads(wr("kv", "key", "list", "--prefix", "pilot:", "--namespace-id", SITE_KV, "--remote"))]
    for n in names:
        r = json.loads(kv("get", n, ns=SITE_KV)); print(f"{r['ts']}  {r['id']}  {r['status']:8} {r['agency']} <{r['email']}>  {len(r['sites'])} site(s)")
    print(f"{len(names)} request(s)")

def stats():
    k = (PRIV / "site_stats_key.txt").read_text().strip()
    print(json.dumps(call("GET", "/api/stats", k, base="https://getformheartbeat.com")[1], indent=1))

def offboard(slug, *rest):
    m = json.loads(keys_file().read_text()); m2 = {h: a for h, a in m.items() if a != slug}
    if len(m2) == len(m): print("no API key for", slug)
    else: put_api_keys(m2); print("API key revoked")
    names = [k["name"] for k in json.loads(wr("kv", "key", "list", "--prefix", "", "--namespace-id", MON_KV, "--remote"))]
    mine = [n for n in names if n in (f"acct:{slug}:targets", f"st:{slug}", f"alerts:{slug}") or n.startswith(f"state:{slug}:") or n.startswith(f"rl:{slug}:")]
    for n in mine: kv("delete", n)
    print(f"deleted {len(mine)} monitoring key(s)")
    if "--pilot-id" in rest: pid = rest[rest.index("--pilot-id") + 1]; kv("delete", f"pilot:{pid}", ns=SITE_KV); print("pilot request deleted")
    d = PRIV / "agencies" / slug
    if d.exists():
        for f in d.iterdir(): f.unlink()
        d.rmdir(); print("local key files deleted")

if __name__ == "__main__":
    cmd, *a = sys.argv[1:] or ["-h"]
    {"onboard": onboard, "test-alert": test_alert, "requests": requests_, "stats": stats, "offboard": offboard}.get(cmd, lambda *_: print(__doc__))(*a)
