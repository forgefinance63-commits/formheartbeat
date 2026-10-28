// Cookie-less, first-party counters (no IDs, no cookies, no fingerprinting): page view + CTA clicks. Pilot form submit via fetch.
(() => {
  const ev = n => { try { navigator.sendBeacon("/api/e", new Blob([JSON.stringify({ e: n })], { type: "text/plain" })); } catch {} };
  ev("pv");
  document.addEventListener("click", e => { const a = e.target.closest("[data-cta]"); if (a) ev("cta:" + a.dataset.cta); });
  const f = document.getElementById("pilot-form"), msg = document.getElementById("pf-msg"); if (!f) return;
  f.addEventListener("submit", async e => {
    e.preventDefault(); msg.className = "fine"; msg.textContent = "Sending…";
    const b = f.querySelector("button"); b.disabled = true;
    try {
      const r = await fetch("/api/pilot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(f))) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { msg.className = "fine ok"; msg.textContent = "Thanks — request received. We'll reply by email from hello@getformheartbeat.com."; f.reset(); }
      else { msg.className = "fine err"; msg.textContent = j.message || "Something went wrong. Please email hello@getformheartbeat.com instead."; b.disabled = false; }
    } catch { msg.className = "fine err"; msg.textContent = "Network error. Please email hello@getformheartbeat.com instead."; b.disabled = false; }
  });
})();
