import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "One model step calls a subagent directly and through a waiting workflow tool; both results resolve inside the same turn.",
  async test(t) {
    const turn = await t.send("WORKFLOW-MIXED-AGENTS-START");
    turn.expectOk();
    turn.calledTool("blocking_agent", { count: 1, status: "completed" });
    turn.event("task.started", { data: { name: "workflow-marker" }, count: 2 });
    turn.event("task.started", { data: { kind: "workflow", name: "blocking_agent" }, count: 1 });
    // Both agent calls and the blocking_agent workflow tool call settle as tasks.
    turn.event("task.settled", { data: { status: "completed" }, count: 3 });
    turn.messageIncludes("WORKFLOW-CHILD:api:blocking");
    turn.messageIncludes("WORKFLOW-CHILD:api:direct");
    turn.event("turn.started", { count: 1 });

    t.succeeded();
    t.noFailedActions();
  },
});
