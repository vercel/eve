import { defineEval } from "eve/evals";

/**
 * Smoke-test eval for `eve eval`.
 *
 * Sends a plain prompt and asserts the agent completes a turn without tools.
 * The prompt instructs a verbatim echo so the check stays stable across real
 * models without a judge.
 */
export default defineEval({
  description: "Text-reply smoke for the eve eval CLI.",

  // Instructing an exact echo keeps the smoke test stable regardless of how
  // the model would otherwise phrase its reply.
  async test(t) {
    await t.send('Reply with exactly the text "smoke ping" and nothing else.');
    t.succeeded();
    t.messageIncludes("smoke ping");
    t.usedNoTools();
  },
});
