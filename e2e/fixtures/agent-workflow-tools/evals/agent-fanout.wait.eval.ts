import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "An authored waiting workflow tool blocks on two parallel agent() calls and returns both inline results.",
  timeoutMs: 60_000,
  async test(t) {
    const turn = await t.send("WORKFLOW-AGENT-FANOUT-START");
    turn.expectOk();
    turn.calledTool("fanout_agents", { count: 1, status: "completed" });
    turn.event("subagent.called", { data: { name: "workflow-marker" }, count: 2 });
    turn.messageIncludes("api:replica-0");
    turn.messageIncludes("api:replica-1");
    turn.eventsSatisfy("both children start before the waiting tool resolves", (events) => {
      const called = events.flatMap((event, index) =>
        event.type === "subagent.called" && event.data.name === "workflow-marker" ? [index] : [],
      );
      const toolResult = events.findIndex(
        (event) =>
          event.type === "action.result" &&
          event.data.result.kind === "tool-result" &&
          event.data.result.toolName === "fanout_agents",
      );
      return called.length === 2 && toolResult >= 0 && Math.max(...called) < toolResult;
    });
    t.noFailedActions();
  },
});
