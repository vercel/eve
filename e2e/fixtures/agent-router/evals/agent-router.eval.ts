import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "agentRouter runs as a task that invokes the root-copy agent, and task_wait delivers its result.",
  async test(t) {
    const turn = await t.send("Route this task.");

    turn.expectOk();
    turn.messageIncludes("AGENT-ROUTER-ROOT-COPY-OK");
    turn.calledTool("agent", { count: 1 });
    turn.calledTool("task_wait", { count: 1 });
    turn.event("task.started", { count: 1, data: { name: "agent" } });
    turn.event("task.settled", { count: 1, data: { status: "completed" } });
    turn.event("agent.started", { count: 1, data: { name: "agent" } });
    t.succeeded();
    t.noFailedActions();
  },
});
