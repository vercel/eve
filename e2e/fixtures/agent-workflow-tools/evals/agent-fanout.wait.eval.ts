import { defineEval } from "eve/evals";
import { agentCallActivity, SessionStore } from "eve/client";
import { waitForStore, interceptFetchOrigin } from "@eve-e2e/config/frontend";

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
    turn.event("child.opened", { data: { name: "workflow-marker" }, count: 2 });
    turn.event("child.sent", { count: 2 });
    turn.eventsSatisfy("parallel sessions are distinct children of one tool call", (events) => {
      const started = events.flatMap((event) =>
        event.type === "child.opened" && event.data.name === "workflow-marker" ? [event.data] : [],
      );
      return (
        started.length === 2 &&
        new Set(started.map(({ owner }) => ("callId" in owner ? owner.callId : undefined))).size ===
          1 &&
        new Set(started.map((session) => session.sessionId)).size === 2
      );
    });
    turn.messageIncludes("api:replica-0");
    turn.messageIncludes("api:replica-1");
    const parentTrace = turn.events.find((event) => event.type === "turn.started")?.data.trace;
    const childTraces = await Promise.all(
      turn.events
        .filter((event) => event.type === "child.opened")
        .map(async (started) => {
          for await (const event of turn.session.agent(started).stream()) {
            if (event.type === "turn.started") return event.data.trace;
            if (event.type === "turn.settled" || event.type === "session.ended") break;
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
        event.type === "child.opened" && event.data.name === "workflow-marker" ? [index] : [],
      );
      const fanout = turn.toolCalls.find((call) => call.name === "fanout_agents");
      const toolResult = events.findIndex(
        (event) => event.type === "call.settled" && event.data.callId === fanout?.callId,
      );
      return called.length === 2 && toolResult >= 0 && Math.max(...called) < toolResult;
    });

    const origin = `https://${crypto.randomUUID()}.invalid`;
    const restoreFetch = interceptFetchOrigin(origin, async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return t.target.fetch(`${url.pathname}${url.search}`, init);
    });
    const store = new SessionStore({
      baseUrl: origin,
      initialSession: { sessionId: turn.sessionId, streamIndex: 0 },
      initialEvents: turn.events,
      followAgents: true,
    });
    const stop = store.observe();
    try {
      await waitForStore(
        store,
        (snapshot) => {
          const children = Object.values(snapshot.agents);
          return (
            children.length === 2 &&
            children.every(
              ({ observation }) =>
                observation.status === "caught-up" &&
                observation.caughtUp &&
                observation.position > 0 &&
                observation.conversation?.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.parts.some(
                      (part) => part.type === "text" && part.text.includes("api:replica-"),
                    ),
                ),
            )
          );
        },
        t.abortSignal,
      );
      turn.eventsSatisfy("one call's accepted deliveries link to both observed child turns", () => {
        const callId = turn.toolCalls.find((call) => call.name === "fanout_agents")?.callId;
        if (callId === undefined) return false;
        const activity = agentCallActivity(store.snapshot, callId);
        return (
          activity.status === "linked" &&
          activity.sessions.length === 2 &&
          activity.sessions.every(
            (session) =>
              session.deliveries.length === 1 &&
              session.deliveries[0]?.status === "settled" &&
              session.turns.length === 1 &&
              session.turns[0]?.turnId === session.deliveries[0]?.turnId,
          )
        );
      });
      turn.eventsSatisfy(
        "the headless store observes workflow children without replaying the root",
        () => store.snapshot.events.length === turn.events.length,
      );
    } catch (cause) {
      const observations = Object.values(store.snapshot.agents).map(({ observation }) =>
        observation.status === "not-followed"
          ? observation
          : {
              status: observation.status,
              reason: observation.reason,
              position: observation.position,
              caughtUp: observation.caughtUp,
              roles: observation.conversation?.messages.map((message) => message.role),
            },
      );
      throw new Error(`Nested prefix capture failed: ${JSON.stringify(observations)}`, { cause });
    } finally {
      stop();
      restoreFetch();
    }

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
    t.noFailedCalls();
  },
});
