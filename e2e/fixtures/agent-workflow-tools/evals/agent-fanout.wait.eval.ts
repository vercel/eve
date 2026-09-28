import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "An authored waiting workflow tool blocks on two parallel ctx.agent sessions and returns both inline results.",
  timeoutMs: 60_000,
  async test(t) {
    const turn = await t.send("WORKFLOW-AGENT-FANOUT-START");
    turn.expectOk();
    turn.calledTool("fanout_agents", { count: 1, status: "completed" });
    turn.event("agent.started", { data: { name: "workflow-marker" }, count: 2 });
    turn.eventsSatisfy("parallel sessions are distinct children of one tool call", (events) => {
      const started = events.flatMap((event) =>
        event.type === "agent.started" && event.data.name === "workflow-marker" ? [event.data] : [],
      );
      return (
        started.length === 2 &&
        new Set(started.map((session) => session.callId)).size === 1 &&
        new Set(started.map((session) => session.sessionId)).size === 2
      );
    });
    turn.messageIncludes("api:replica-0");
    turn.messageIncludes("api:replica-1");
    turn.eventsSatisfy("both children start before the waiting tool resolves", (events) => {
      const called = events.flatMap((event, index) =>
        event.type === "agent.started" && event.data.name === "workflow-marker" ? [index] : [],
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
