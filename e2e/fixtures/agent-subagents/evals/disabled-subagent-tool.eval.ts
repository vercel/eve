import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A same-named disableTool hides a subagent from the model without blocking workflow invocation.",
  async test(t) {
    const turn = await t.send("E2E_DISABLED_SUBAGENT");

    turn.expectOk();
    turn.messageIncludes("DISABLED-SUBAGENT-OK");
    turn.calledTool("invoke-hidden", { count: 1 });
    turn.calledSubagent("disabled-hidden", { count: 1, status: "completed" });
    turn.calledSubagent("tool-hidden", { count: 0 });
    t.succeeded();
    t.noFailedActions();
  },
});
