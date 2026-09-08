import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import {
  completeReport,
  intermediateWakes,
  requireStreamIndex,
  silentWake,
  startWarehouseLookups,
  waitForPartialCompletion,
  waitForReport,
} from "./reporting.js";

function reportingEval() {
  return defineEval({
    description:
      "A stock eve agent acknowledges accepted background work, keeps partial wakes silent, and reports all results after settlement.",
    tags: ["real-model"],
    async test(t) {
      const run = await startWarehouseLookups(t);
      await waitForPartialCompletion(t, run);

      const compaction = t.target.watchTurn(run.sessionId, {
        startIndex: requireStreamIndex(run.session),
      });
      const response = await t.target.fetch(
        `/eve/v1/session/${encodeURIComponent(run.sessionId)}/compact`,
        {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      await t.require(
        response.status,
        satisfies((status: number) => status === 202, "parent session accepts compaction"),
      );
      const compactedTurn = await compaction.result();
      compactedTurn.event("compaction.requested", { count: 1 });
      // A declined summary preserves history; the caller still needs the complete report.
      compactedTurn
        .event("compaction.completed", { count: 1 })
        .soft()
        .label("successful checkpoint");
      compactedTurn.noFailedActions();
      run.session = compaction.session;

      const report = await waitForReport(t, run);
      for (const wake of intermediateWakes(run)) {
        await t.require(wake.message, silentWake());
      }
      await t.require(report, completeReport());
      t.noFailedActions();
    },
  });
}

export default Array.from({ length: 8 }, reportingEval);
