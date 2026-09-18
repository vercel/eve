import { defineEval } from "eve/evals";

export default defineEval({
  description: "agentRouter invokes the root-copy agent when it is the sole available target.",
  async test(t) {
    const turn = await t.send("Route this task.");

    turn.expectOk();
    turn.messageIncludes("AGENT-ROUTER-ROOT-COPY-OK");
    turn.calledTool("agent-router", { count: 1 });
    turn.calledSubagent("agent", { count: 1, status: "pending" });
    t.succeeded();
    t.noFailedActions();
  },
});
