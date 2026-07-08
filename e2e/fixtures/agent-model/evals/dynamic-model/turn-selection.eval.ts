import { defineEval } from "eve/evals";

/**
 * A marked turn selects `openai/gpt-5.5-mini`; the next unmarked turn falls
 * back. Both completing proves each reference serves a real model call.
 */
export default defineEval({
  description: "Dynamic model smoke: per-turn selection and null fallback in one session.",
  async test(t) {
    const selected = await t.send(
      '[model: mini] Reply with exactly the text "mini ping" and nothing else.',
    );
    selected.expectOk();
    selected.messageIncludes("mini ping");

    const fallback = await t.send('Reply with exactly the text "fallback again" and nothing else.');
    fallback.expectOk();
    fallback.messageIncludes("fallback again");

    t.succeeded();
    t.usedNoTools();
  },
});
