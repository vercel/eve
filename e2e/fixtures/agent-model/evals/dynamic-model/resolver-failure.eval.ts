import { defineEval } from "eve/evals";

/** A throwing resolver degrades to the fallback model instead of failing the turn. */
export default defineEval({
  description: "Dynamic model smoke: a throwing resolver falls back instead of failing the turn.",
  async test(t) {
    await t.send('[model: boom] Reply with exactly the text "still here" and nothing else.');

    t.succeeded();
    t.messageIncludes("still here");
    t.usedNoTools();
  },
});
