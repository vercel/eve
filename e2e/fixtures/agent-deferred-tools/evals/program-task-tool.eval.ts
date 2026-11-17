import { EXECUTE_TOOL, TASK_WAIT_TOOL } from "@eve-e2e/config/catalog-tools";
import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A program that calls a background workflow tool parks until the run returns and resumes with its result, not a task receipt, then keeps running.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("PROGRAM-RESEARCH Alice asks for research on refunds.");

    turn.expectOk();
    turn.noFailedCalls();
    // The model's own call to this tool starts a task; a program awaits the run's result.
    turn.calledTool("research_report", { count: 1, output: "RESEARCH-FINDINGS:refunds" });
    turn.notEvent("task.started");
    turn.notEvent("call.requested", { data: { capability: { name: TASK_WAIT_TOOL } } });
    // The call after the wait proves the program resumed where it parked.
    t.toolOrder([EXECUTE_TOOL, "research_report", "lookup_invoice"]);
    t.calledTool(EXECUTE_TOOL, {
      count: 1,
      output: {
        calls: { completed: 2 },
        result: { findings: "RESEARCH-FINDINGS:refunds", status: "paid" },
      },
    });
    t.messageIncludes('PROGRAM-RESULT {"findings":"RESEARCH-FINDINGS:refunds","status":"paid"}');
  },
});
