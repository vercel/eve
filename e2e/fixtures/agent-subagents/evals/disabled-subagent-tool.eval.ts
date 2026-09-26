import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A same-named disableTool hides a subagent from the model without blocking workflow invocation.",
  async test(t) {
    const turn = await t.send("E2E_DISABLED_SUBAGENT");

    turn.expectOk();
    turn.messageIncludes("DISABLED-SUBAGENT-OK");
    turn.calledTool("invoke-hidden", { count: 1 });
    turn.event("agent.started", { count: 1, data: { name: "disabled-hidden" } });
    t.succeeded();
    t.noFailedActions();
  },
});
