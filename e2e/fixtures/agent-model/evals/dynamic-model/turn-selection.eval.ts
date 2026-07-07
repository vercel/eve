import { defineEval } from "eve/evals";

/**
 * Dynamic-model smoke: a `turn.started` selection routes the marked turn to
 * `openai/gpt-5.5-mini`, and the next unmarked turn (resolver returns `null`)
 * falls back to the compiled fallback model. Both turns completing proves the
 * selected reference and the fallback each serve a real model call in the
 * same session.
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
