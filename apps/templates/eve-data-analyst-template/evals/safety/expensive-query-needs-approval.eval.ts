import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Pauses an expensive query for approval, and offers a narrower one when the asker cancels.",
  async test(t) {
    const turn = await t.send(
      "Run exactly this SQL and tell me the result: SELECT count(*) FROM analytics.web_sessions a CROSS JOIN analytics.web_sessions b"
    );
    turn.parked();
    turn.session.requireInputRequest({
      optionIds: ["approve", "cancel"],
      toolName: "run_sql",
    });
    const cancelled = await turn.session.respondAll("cancel");
    cancelled.succeeded();
    t.judge(
      "The reply says the query was not run and offers a cheaper alternative, such as a narrower time range, an aggregate, or a sample.",
      { on: cancelled.message }
    ).atLeast(0.7);
  },
});
