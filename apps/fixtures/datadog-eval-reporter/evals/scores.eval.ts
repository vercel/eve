import { defineEval } from "eve/evals";
import { equals, includes, similarity } from "eve/evals/expect";

export default defineEval({
  description: "One output scored by exact, substring, and fuzzy assertions.",
  tags: ["multiple-scorers"],

  async test(t) {
    const turn = await t.send("Return alpha beta gamma.");
    t.check(turn.message, equals("alpha beta gamma")).label("exact output");
    t.check(turn.message, includes("gamma").soft()).label("contains gamma");
    t.check(turn.message, similarity("alpha beta")).label("near match");
    t.succeeded();
  },
});
