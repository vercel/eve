import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A subagent with tool false stays hidden from the model and callable through a workflow tool.",
  async test(t) {
    const turn = await t.send("E2E_TOOL_FALSE_SUBAGENT");

    turn.expectOk();
    turn.messageIncludes("TOOL-FALSE-SUBAGENT-OK");
    turn.messageIncludes("Internal specialist hidden by its agent definition.");
    turn.calledTool("invoke-hidden", { count: 1 });
    turn.event("agent.started", { count: 1, data: { name: "tool-hidden" } });
    t.succeeded();
    t.noFailedActions();
  },
});
