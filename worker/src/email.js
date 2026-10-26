// Email provider abstraction. Inactive unless ALERTS_ENABLED === "true". API keys come only from Worker secrets.
export function render(alert) {
  if (alert.type === "down") return { subject: `[FormHeartbeat] Check failing: ${alert.url}`,
    text: `Two consecutive checks failed for ${alert.url}.\nProblems: ${alert.problems.join(", ")}\n\nThis is a read-only external check. It does not test form submission or lead delivery.` };
  return { subject: `[FormHeartbeat] Recovered: ${alert.url}`, text: `Checks for ${alert.url} are passing again.` };
}
const providers = {
  brevo: (env, fetchImpl) => async (to, m) => fetchImpl("https://api.brevo.com/v3/smtp/email", { method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { email: env.ALERT_FROM, name: env.ALERT_FROM_NAME || "FormHeartbeat" }, to: [{ email: to }],
      subject: m.subject, textContent: m.text, tags: ["formheartbeat-alert"] }) }),
  resend: (env, fetchImpl) => async (to, m) => fetchImpl("https://api.resend.com/emails", { method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM, to: [to], subject: m.subject, text: m.text }) }),
  mailchannels: (env, fetchImpl) => async (to, m) => fetchImpl("https://api.mailchannels.net/tx/v1/send", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.MAILCHANNELS_API_KEY },
    body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: env.ALERT_FROM }, subject: m.subject, content: [{ type: "text/plain", value: m.text }] }) }),
};
const KEY_OF = { brevo: "BREVO_API_KEY", resend: "RESEND_API_KEY", mailchannels: "MAILCHANNELS_API_KEY" };
const off = reason => ({ enabled: false, reason, send: async () => ({ skipped: reason }) });
/** Enabled only if ALERTS_ENABLED==="true" AND the provider secret AND ALERT_FROM exist. Never throws on send. */
export function createMailer(env, fetchImpl = fetch) {
  if (env.ALERTS_ENABLED !== "true") return off("alerts_disabled");
  const name = env.EMAIL_PROVIDER || "brevo", p = providers[name]; if (!p) return off("unknown_provider");
  if (!env[KEY_OF[name]]) return off("missing_api_key");
  if (!env.ALERT_FROM) return off("missing_sender");
  const send = p(env, fetchImpl);
  return { enabled: true, send: async (to, alert) => {
    try { const r = await send(to, render(alert)); return { status: r.status, ok: r.status >= 200 && r.status < 300 }; }
    catch { return { status: 0, ok: false, error: "network_error" }; } } };
}
