import { defineEval } from "eve/evals";

/**
 * Raw measurements survive the CLI/runtime boundary: a tracked-only `t.score`
 * carries no verdict, and a gated one reports its threshold next to the
 * untouched score. The fixture reporter checks the finalized shape.
 */
export default defineEval({
  description: "Scores: raw measurements with and without an acceptance rule.",

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
