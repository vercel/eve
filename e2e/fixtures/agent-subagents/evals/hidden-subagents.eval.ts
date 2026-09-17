import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A subagent with tool false stays hidden from the model and callable through a workflow tool.",
  async test(t) {
    const turn = await t.send("E2E_TOOL_FALSE_SUBAGENT");

    turn.expectOk();
    turn.messageIncludes("TOOL-FALSE-SUBAGENT-OK");
    turn.calledTool("invoke-hidden", { count: 1 });
    turn.calledSubagent("tool-hidden", { count: 1, status: "pending" });
    turn.calledSubagent("disabled-hidden", { count: 0, status: "pending" });
    t.succeeded();
    t.noFailedActions();
  },
});
