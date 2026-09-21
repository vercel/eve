import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Removing a discovered destination prevents later calls from starting replacement work.",
  async test(t) {
    const turn = await t.send(
      "Alice removes a temporary directory entry before using it. DYNAMIC_AGENT_REGISTRY stale",
    );
    turn.expectOk().messageIncludes("STALE-AGENT-REJECTED");
    turn.calledTool("reject-stale-agent", { count: 1 });
    turn.calledSubagent("researcher", { count: 0 });
    t.succeeded();
    t.noFailedActions();
  },
});
