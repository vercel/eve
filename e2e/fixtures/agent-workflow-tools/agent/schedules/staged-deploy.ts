import { defineSchedule } from "eve/schedules";

/**
 * Fired on demand by `evals/held-turn.schedule.eval.ts`. The directive runs
 * the root agent's held-turn script: stage a deploy, write while the task
 * works, then report its result.
 */
export default defineSchedule({
  cron: "0 0 * * *",
  markdown: "WORKFLOW-STAGE-HOLD Stage the nightly api deploy and report its digest.",
});
