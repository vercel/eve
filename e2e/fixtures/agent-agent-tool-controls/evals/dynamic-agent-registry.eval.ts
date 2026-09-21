import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Startup and ordinary-tool registrations enter the next model request without invocation.",
  async test(t) {
    const turn = await t.send(
      "Alice wants to populate her agent directory. DYNAMIC_AGENT_REGISTRY register",
    );
    turn.expectOk().messageIncludes("DYNAMIC-AGENT-REGISTERED");
    turn.calledTool("discover-agents", { count: 1 });
    turn.calledSubagent("researcher", { count: 0 });
    t.succeeded();
    t.noFailedActions();
  },
});
