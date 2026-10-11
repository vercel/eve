import { defineEval } from "eve/evals";
import { isCurrentTurnBoundaryEvent } from "eve/client";

import { readHookAudit, recordsEveryAgentStart } from "./subagent-hook-audit.shared";

export default defineEval({
  description:
    "An authored waiting workflow tool blocks on two parallel ctx.agent sessions, returns both inline results, and agent.started hooks record both sessions.",
  timeoutMs: 60_000,
  async test(t) {
    const turn = await t.send(
      "WORKFLOW-AGENT-FANOUT-START Bob asks two planners to draft the api rollout and waits for both drafts.",
    );
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
    const parentTrace = turn.events.find((event) => event.type === "turn.started")?.data.trace;
    const childTraces = await Promise.all(
      turn.events
        .filter((event) => event.type === "agent.started")
        .map(async (started) => {
          for await (const event of turn.session.agent(started).stream()) {
            if (event.type === "turn.started") return event.data.trace;
            if (isCurrentTurnBoundaryEvent(event)) break;
          }
          return undefined;
        }),
    );
    turn.eventsSatisfy(
      "parallel local children share the caller trace but not span identity",
      () =>
        parentTrace !== undefined &&
        childTraces.length === 2 &&
        childTraces.every(
          (child) =>
            child !== undefined &&
            child.traceId === parentTrace.traceId &&
            child.spanId !== parentTrace.spanId,
        ) &&
        new Set(childTraces.map((child) => child?.spanId)).size === 2,
    );
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

    const audit = await turn.session.send(
      "Bob reviews the recorded hook observations for both planners. SUBAGENT-HOOKS:AUDIT",
    );
    audit.expectOk();
    audit.calledTool("read_subagent_hooks", { count: 1, status: "completed" });
    const records = readHookAudit(audit);
    turn.eventsSatisfy(
      "both hook subscriptions record each opened session in parent state and sandbox",
      (events) => recordsEveryAgentStart(records, events, turn.sessionId),
    );
    t.noFailedActions();
  },
});
