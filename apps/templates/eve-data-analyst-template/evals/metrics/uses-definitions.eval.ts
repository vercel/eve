import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Loads the metric definitions before computing a business metric and states the period.",
  async test(t) {
    await t.send("What was net revenue last month?");
    t.succeeded();
    t.loadedSkill("metric-definitions");
    t.calledTool("run_sql");
    t.judge(
      "The reply gives a dollar figure for net revenue, states the exact date range and time zone it covers, and says refunds were subtracted."
    ).atLeast(0.7);
  },
});
