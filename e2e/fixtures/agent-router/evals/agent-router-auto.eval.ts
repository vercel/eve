import { defineEval } from "eve/evals";

export default defineEval({
  description: "The exported agent-router auto helper runs as an authored workflow step.",
  async test(t) {
    const turn = await t.send("E2E_AGENT_ROUTER_AUTO");

    turn.expectOk();
    turn.messageIncludes("AGENT-ROUTER-ROOT-COPY-OK");
    turn.calledTool("route-one", { count: 1 });
    turn.calledSubagent("agent", { count: 1, status: "pending" });
    t.succeeded();
    t.noFailedActions();
  },
});
