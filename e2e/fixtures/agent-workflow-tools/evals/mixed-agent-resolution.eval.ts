import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "One model step calls a subagent directly and through a waiting workflow tool; both results resolve inside the same turn.",
  async test(t) {
    const turn = await t.send("WORKFLOW-MIXED-AGENTS-START");
    turn.expectOk();
    turn.calledTool("blocking_agent", { count: 1, status: "completed" });
    turn.event("subagent.called", { data: { name: "workflow-marker" }, count: 2 });
    turn.event("subagent.completed", { data: { subagentName: "workflow-marker" }, count: 2 });
    turn.messageIncludes("WORKFLOW-CHILD:api:blocking");
    turn.messageIncludes("WORKFLOW-CHILD:api:direct");
    turn.event("turn.started", { count: 1 });

    t.succeeded();
    t.noFailedActions();
  },
});
