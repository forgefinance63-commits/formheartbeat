// Strict outbound URL validation (SSRF defense). Pure functions + injectable DNS resolver.
export const ALLOWED_PORTS = new Set(["", "443"]);
export const LIMITS = { maxBytes: 1_000_000, timeoutMs: 10_000, maxRedirects: 3, maxUrlLength: 2048 };
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".arpa"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

function v4ToInt(ip) {
  const p = ip.split(".");
  if (p.length !== 4 || !p.every(x => /^\d{1,3}$/.test(x) && +x <= 255)) return null;
  return p.reduce((a, x) => a * 256 + +x, 0);
}
const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([b, m]) => [v4ToInt(b), m]);
export function isPrivateV4(ip) {
  const n = v4ToInt(ip); if (n === null) return false;
  return V4_BLOCKS.some(([b, m]) => Math.floor(n / 2 ** (32 - m)) === Math.floor(b / 2 ** (32 - m)));
}
export function isPrivateV6(ip) {
  let h = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::1") return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (mapped) return isPrivateV4(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) return true; // mapped hex form: block conservatively
  if (/^(fc|fd)/.test(h)) return true;          // unique local
  if (/^fe[89ab]/.test(h)) return true;         // link-local
  if (/^ff/.test(h)) return true;               // multicast
  if (/^(64:ff9b|2001:db8|2001:0?:|2002:)/.test(h)) return true; // NAT64, doc, teredo, 6to4
  if (/^fd00:ec2::254$/.test(h)) return true;   // AWS IMDS v6
  return false;
}
export const isIpLiteral = h => v4ToInt(h) !== null || h.includes(":");
export const isPrivateIp = ip => (ip.includes(":") ? isPrivateV6(ip) : isPrivateV4(ip));

/** Synchronous syntactic checks. Returns {ok, url?, reason?} */
export function validateUrlSyntax(raw) {
  if (typeof raw !== "string" || raw.length > LIMITS.maxUrlLength) return { ok: false, reason: "invalid_length" };
  let u; try { u = new URL(raw); } catch { return { ok: false, reason: "unparseable" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "https_only" };
  if (u.username || u.password) return { ok: false, reason: "userinfo_not_allowed" };
  if (!ALLOWED_PORTS.has(u.port)) return { ok: false, reason: "port_not_allowed" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "no_host" };
  if (isIpLiteral(host)) return { ok: false, reason: isPrivateIp(host) ? "private_ip" : "ip_literal_not_allowed" };
  if (/^\d+$/.test(host) || /^0x/i.test(host)) return { ok: false, reason: "numeric_host" }; // decimal/hex IP forms
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some(s => host.endsWith(s)) || !host.includes("."))
    return { ok: false, reason: "non_public_hostname" };
  return { ok: true, url: u };
}

/** DNS-over-HTTPS resolver (Cloudflare). Injectable for tests. */
export async function dohResolve(host, fetchImpl = fetch) {
  const out = [];
  for (const type of ["A", "AAAA"]) {
    const r = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      { headers: { accept: "application/dns-json" } });
    if (!r.ok) continue;
    const j = await r.json();
    for (const a of j.Answer || []) if (a.type === 1 || a.type === 28) out.push(a.data);
  }
  return out;
}

/** Full validation incl. DNS: every resolved address must be public. */
export async function validateUrl(raw, { resolve = dohResolve } = {}) {
  const s = validateUrlSyntax(raw); if (!s.ok) return s;
  let ips; try { ips = await resolve(s.url.hostname); } catch { return { ok: false, reason: "dns_error" }; }
  if (!ips.length) return { ok: false, reason: "dns_no_records" };
  if (ips.some(isPrivateIp)) return { ok: false, reason: "resolves_to_private_ip" };
  return { ok: true, url: s.url, ips };
}

/** Fetch with manual redirects (each hop re-validated), timeout and body size cap. */
export async function safeFetch(raw, { method = "GET", fetchImpl = fetch, resolve = dohResolve, ua } = {}) {
  let url = raw;
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    const v = await validateUrl(url, { resolve });
    if (!v.ok) return { status: 0, error: `blocked:${v.reason}`, body: "" };
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), LIMITS.timeoutMs);
    const started = Date.now();
    let r;
    try { r = await fetchImpl(v.url.toString(), { method, redirect: "manual", signal: ctl.signal, headers: { "User-Agent": ua } }); }
    catch (e) { clearTimeout(t); return { status: 0, error: ctl.signal.aborted ? "timeout" : "network_error", body: "" }; }
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      clearTimeout(t);
      const loc = r.headers.get("location"); if (!loc) return { status: r.status, error: "redirect_without_location", body: "" };
      url = new URL(loc, v.url).toString(); continue;
    }
    let body = "";
    if (method === "GET" && r.body) {
      const reader = r.body.getReader(); const dec = new TextDecoder(); let n = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break;
          n += value.byteLength; if (n > LIMITS.maxBytes) { reader.cancel(); clearTimeout(t); return { status: r.status, error: "too_large", body: "" }; }
          body += dec.decode(value, { stream: true }); }
      } catch { clearTimeout(t); return { status: 0, error: "timeout", body: "" }; }
    }
    clearTimeout(t);
    return { status: r.status, ms: Date.now() - started, body, url: v.url.toString() };
  }
  return { status: 0, error: "too_many_redirects", body: "" };
}
