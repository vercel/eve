import { defineEval } from "eve/evals";

/**
 * A marked turn selects an explicit reference to `EVE_E2E_MODEL`; the next
 * unmarked turn falls back to the same matrix-selected model. Both completing
 * proves the selection and fallback paths serve real model calls.
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
