import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A deferred background workflow tool called through execute returns a task receipt, and its result arrives as a task result.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("DEFERRED-RESEARCH Alice asks for research on refunds.");

    turn.expectOk();
    turn.noFailedActions();
    turn.calledTool("research_report", { count: 1, output: /^Started task research_report-/u });
    turn.event("task.started", { count: 1 });
    turn.event("task.settled", { count: 1, data: { output: "RESEARCH-FINDINGS:refunds" } });
    t.messageIncludes("RESEARCH-RESULT RESEARCH-FINDINGS:refunds");
  },
});
