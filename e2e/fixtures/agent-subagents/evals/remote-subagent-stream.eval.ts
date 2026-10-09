import { endsTurn, type ChildOpened, type SessionStreamEvent } from "eve/client";
import { toolCallsOf } from "eve/evals";
import { defineEval, type EveEvalContext, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { WORKSPACE_FORWARDING_MARKER, WORKSPACE_LOOKUP_MESSAGE } from "../constants";

const CREATE_CHILD_MESSAGE = [
  WORKSPACE_FORWARDING_MARKER,
  "Use remote-loopback with this message:",
  JSON.stringify(WORKSPACE_LOOKUP_MESSAGE),
].join(" ");

/** A client follows a remote child's activity through the parent session's proxy route. */
export default defineEval({
  tags: ["subagent-stream"],
  description:
    "A client reads a remote child's tool activity through the parent session instead of addressing the child deployment.",
  async test(t) {
    const turn = await t.send(CREATE_CHILD_MESSAGE);
    turn.expectOk();
    turn.eventsSatisfy("remote agent calls preserve dispatch kind", (events) =>
      events.some(
        (event) =>
          event.type === "call.requested" &&
          event.data.capability.kind === "agent" &&
          event.data.capability.name === "remote-loopback",
      ),
    );
    const started = await requireRemoteSession(t, turn);

    const childEvents: SessionStreamEvent[] = [];
    for await (const event of turn.session.agent(started).stream()) {
      childEvents.push(event);
      if (endsTurn(event)) break;
    }

    await t.require(
      childEvents,
      satisfies(
        (events: readonly SessionStreamEvent[]) =>
          toolCallsOf(events).some(
            (call) => call.name === "read-workspace-label" && call.status === "completed",
          ),
        "the proxied child stream carries the child's completed workspace lookup",
      ),
    );
    const parentTrace = turn.events.find((event) => event.type === "turn.started")?.data.trace;
    const childTrace = childEvents.find((event) => event.type === "turn.started")?.data.trace;
    turn.eventsSatisfy(
      "remote dispatch starts a distinct child trace",
      () =>
        parentTrace !== undefined &&
        childTrace !== undefined &&
        childTrace.traceId !== parentTrace.traceId &&
        childTrace.spanId !== parentTrace.spanId,
    );
    t.succeeded();
  },
});

/** The parent may finish its turn before recording the session; wait for it on the stream if so. */
async function requireRemoteSession(t: EveEvalContext, turn: EveEvalTurn): Promise<ChildOpened> {
  for (const event of turn.events) {
    if (event.type === "child.opened" && event.data.name === "remote-loopback") return event;
  }
  return await t.target
    .watchTurn(turn.sessionId, { startIndex: turn.session.state.streamIndex })
    .waitForEvent("child.opened", { data: { name: "remote-loopback" } });
}
