// Deployed entry point. Adds a self service binding (env.RUNNER -> Runner) so every account and every site runs in its
// own invocation, each with its own free-plan budget (50 subrequests, CPU). Node tests import ./index.js directly.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { runAccount, checkSite } from "./index.js";
export class Runner extends WorkerEntrypoint {
  async runAccount(acct) { return runAccount(this.env, acct); }
  async checkSite(acct, t, prev) { return checkSite(this.env, acct, t, prev); }
}
export default worker;
