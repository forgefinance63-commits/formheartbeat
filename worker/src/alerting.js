// Alert state machine: alert after N consecutive FAILs, one recovery notice, dedupe.
export const FAIL_THRESHOLD = 2;
export function evaluate(prev, result) {
  const s = { consecutiveFails: 0, alerted: false, lastAlertKey: null, ...(prev || {}) };
  const failed = result.result === "FAIL";
  s.consecutiveFails = failed ? s.consecutiveFails + 1 : 0;
  s.lastResult = result.result; s.lastTs = result.ts;
  let alert = null;
  if (failed && s.consecutiveFails >= FAIL_THRESHOLD) {
    const key = result.problems.slice().sort().join("|");
    if (!s.alerted || s.lastAlertKey !== key) { alert = { type: "down", url: result.url, problems: result.problems, key }; s.alerted = true; s.lastAlertKey = key; }
  } else if (!failed && s.alerted) {
    alert = { type: "recovered", url: result.url }; s.alerted = false; s.lastAlertKey = null;
  }
  return { state: s, alert };
}
