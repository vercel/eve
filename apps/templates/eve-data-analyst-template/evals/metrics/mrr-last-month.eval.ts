import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import type config from "../evals.config.js";
import { mentionsAmountNear } from "../lib/ground-truth.js";

/* "2026-09-01" → "September 2026", the way the agent names the month. */
const monthName = (monthStart: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${monthStart}T00:00:00Z`));

export default defineEval<typeof config>({
  description:
    "Answers MRR last month with the canonical definition, excluding internal accounts.",
  async test(t) {
    const { truth } = t.context;
    const turn = await t.send("What was our MRR last month?");
    t.succeeded();
    t.loadedSkill("metric-definitions");
    t.calledTool("run_sql");
    t.check(
      turn.message,
      satisfies(
        (message) =>
          mentionsAmountNear(String(message), truth.mrrLastMonth, 0.005),
        `mentions MRR within 0.5% of $${truth.mrrLastMonth}`
      )
    );
    t.judge(
      `The reply presents the figure as MRR for ${monthName(truth.lastMonthStart)}.`,
      { on: turn.message }
    ).atLeast(0.6);
  },
});
