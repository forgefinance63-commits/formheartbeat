// Email provider abstraction. Inactive unless ALERTS_ENABLED === "true". API keys come only from Worker secrets.
export function render(alert) {
  if (alert.type === "down") return { subject: `[FormHeartbeat] Check failing: ${alert.url}`,
    text: `Two consecutive checks failed for ${alert.url}.\nProblems: ${alert.problems.join(", ")}\n\nThis is a read-only external check. It does not test form submission or lead delivery.` };
  return { subject: `[FormHeartbeat] Recovered: ${alert.url}`, text: `Checks for ${alert.url} are passing again.` };
}
const providers = {
  resend: (env, fetchImpl) => async (to, m) => fetchImpl("https://api.resend.com/emails", { method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM, to: [to], subject: m.subject, text: m.text }) }),
  mailchannels: (env, fetchImpl) => async (to, m) => fetchImpl("https://api.mailchannels.net/tx/v1/send", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.MAILCHANNELS_API_KEY },
    body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: env.ALERT_FROM }, subject: m.subject, content: [{ type: "text/plain", value: m.text }] }) }),
};
export function createMailer(env, fetchImpl = fetch) {
  if (env.ALERTS_ENABLED !== "true") return { enabled: false, send: async () => ({ skipped: "alerts_disabled" }) };
  const p = providers[env.EMAIL_PROVIDER]; if (!p) throw new Error("unknown EMAIL_PROVIDER");
  const send = p(env, fetchImpl);
  return { enabled: true, send: async (to, alert) => { const r = await send(to, render(alert)); return { status: r.status }; } };
}
