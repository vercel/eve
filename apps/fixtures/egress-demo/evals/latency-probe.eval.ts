import { defineEval } from "eve/evals";

/**
 * Automates the interactive park/resume crossing for sandbox egress
 * authorization and measures the consent round-trip: challenge shown ->
 * callback accepted -> parked turn resumed. `eve eval` sessions run as a
 * synthetic authenticated user, so the eager interactive rule parks instead
 * of failing. Requires linked-project Vercel Sandbox credentials
 * (`vercel link && vercel env pull`); run on demand, not part of any CI
 * suite.
 */
export default defineEval({
  description: "Latency probe: sandbox egress consent callback to resume.",
  timeoutMs: 300_000,
  async test(t) {
    const startedAt = Date.now();
    const turn = await t.start("Fetch me some GitHub zen.");

    const required = await turn.waitForEvent("authorization.required");
    if (
      required?.type !== "authorization.required" ||
      required.data.authorization?.url === undefined
    ) {
      throw new Error("Expected a sandbox egress authorization URL.");
    }
    const challengeAt = Date.now();
    const url = required.data.authorization.url;
    t.log(`challenge after ${challengeAt - startedAt}ms: ${url}`);

    const clickAt = Date.now();
    const callback = await fetch(url);
    const callbackBody = await callback.text();
    t.log(`callback answered ${callback.status} in ${Date.now() - clickAt}ms`);
    if (!callback.ok) {
      throw new Error(`Consent callback failed (${String(callback.status)}): ${callbackBody}`);
    }

    const completed = await turn.waitForEvent("authorization.completed");
    t.log(`authorization.completed ${Date.now() - clickAt}ms after the click`);
    if (completed?.type !== "authorization.completed") {
      throw new Error("Expected authorization completion.");
    }

    const result = await turn.result();
    const settledAt = Date.now();
    t.log(`turn settled ${settledAt - clickAt}ms after the click`);
    result.expectOk();
    t.log(`total turn time ${settledAt - startedAt}ms`);
    t.succeeded();
  },
});
