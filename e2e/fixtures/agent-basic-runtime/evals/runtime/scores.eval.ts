import { defineEval } from "eve/evals";

/**
 * Runs `t.score` end to end: one score without a rule, one gated score that
 * decides the eval.
 */
export default defineEval({
  description: "Scores with and without a rule.",

  async test(t) {
    const turn = await t.send('Reply with exactly the text "score ping" and nothing else.');
    t.succeeded();

    const reply = turn.message ?? "";
    t.score({
      score: Math.max(0, 1 - reply.length / 400),
      metadata: { length: reply.length },
    }).label("reply-brevity");
    t.score(reply.includes("score ping") ? 1 : 0)
      .label("mentions-ping")
      .gate();
  },
});
