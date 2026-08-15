import { defineEval } from "eve/evals";

/**
 * Both turns select the matrix model independently. The first uses a smaller
 * explicit context window so the session exercises metadata replacement.
 */
export default defineEval({
  description: "Dynamic model smoke: concrete per-turn selections in one session.",
  async test(t) {
    const selected = await t.send(
      '[model: mini] Reply with exactly the text "mini ping" and nothing else.',
    );
    selected.expectOk();
    selected.messageIncludes("mini ping");

    const selectedAgain = await t.send(
      'Reply with exactly the text "selected again" and nothing else.',
    );
    selectedAgain.expectOk();
    selectedAgain.messageIncludes("selected again");

    t.succeeded();
    t.usedNoTools();
  },
});
