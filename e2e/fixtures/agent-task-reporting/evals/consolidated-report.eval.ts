import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  compactWhilePending,
  modelSteps,
  startWarehouseLookups,
  waitForPartialCompletion,
  waitForReport,
} from "./reporting.js";

function reportingEval() {
  return defineEval({
    description:
      "A real parent retains a completed child's result across compaction while its siblings are gated, then reports the whole cohort including a nested lookup.",
    tags: ["real-model"],
    async test(t) {
      const run = await startWarehouseLookups(t);
      await waitForPartialCompletion(t, run);
      await compactWhilePending(t, run);
      await waitForReport(t, run);
      t.check(modelSteps(run.parentTurns), equals(1)).label(
        "compaction does not admit partial successes; only the settled cohort invokes the parent model",
      );
      t.noFailedActions();
    },
  });
}

export default Array.from({ length: 8 }, reportingEval);
