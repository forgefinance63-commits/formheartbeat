// API-key auth: env.API_KEYS (secret) = JSON {"<sha256-hex-of-key>": "<accountId>"}. Raw keys never stored.
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function ctEq(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
export async function authenticate(req, env) {
  const h = req.headers.get("authorization") || ""; const m = h.match(/^Bearer ([A-Za-z0-9_\-]{24,128})$/);
  if (!m) return null;
  let map; try { map = JSON.parse(env.API_KEYS || "{}"); } catch { return null; }
  const hash = await sha256Hex(m[1]); let acct = null;
  for (const [k, v] of Object.entries(map)) if (ctEq(k, hash)) acct = v;
  return acct;
}
/** Fixed-window rate limit in KV: limit per window seconds per account+action. */
export async function rateLimit(kv, acct, action, limit, windowSec, now = Date.now()) {
  const w = Math.floor(now / 1000 / windowSec); const key = `rl:${acct}:${action}:${w}`;
  const n = +(await kv.get(key)) || 0; if (n >= limit) return false;
  await kv.put(key, String(n + 1), { expirationTtl: Math.max(60, windowSec * 2) }); return true;
}
