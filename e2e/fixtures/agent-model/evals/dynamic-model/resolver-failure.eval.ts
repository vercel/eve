import { defineEval } from "eve/evals";

/**
 * Dynamic-model smoke: a throwing resolver degrades to the compiled
 * `fallback` model instead of failing the turn. The marker makes the
 * fixture's `turn.started` resolver throw before returning a selection.
 */
export default defineEval({
  description: "Dynamic model smoke: a throwing resolver falls back instead of failing the turn.",
  async test(t) {
    await t.send('[model: boom] Reply with exactly the text "still here" and nothing else.');

    t.succeeded();
    t.messageIncludes("still here");
    t.usedNoTools();
  },
});
