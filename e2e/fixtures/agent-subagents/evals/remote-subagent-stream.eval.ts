import {
  isCurrentTurnBoundaryEvent,
  type AgentStartedStreamEvent,
  type MessageStreamEvent,
} from "eve/client";
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
    const started = await requireRemoteSession(t, turn);

    const childEvents: MessageStreamEvent[] = [];
    for await (const event of turn.session.streamSubagent(started)) {
      childEvents.push(event);
      if (isCurrentTurnBoundaryEvent(event)) break;
    }

    await t.require(
      childEvents,
      satisfies(
        (events: readonly MessageStreamEvent[]) =>
          events.some(
            (event) =>
              event.type === "action.result" &&
              event.data.status === "completed" &&
              event.data.result.kind === "tool-result" &&
              event.data.result.toolName === "read-workspace-label",
          ),
        "the proxied child stream carries the child's completed workspace lookup",
      ),
    );
    t.succeeded();
  },
});

/** The parent may finish its turn before recording the session; wait for it on the stream if so. */
async function requireRemoteSession(
  t: EveEvalContext,
  turn: EveEvalTurn,
): Promise<AgentStartedStreamEvent> {
  for (const event of turn.events) {
    if (event.type === "agent.started" && event.data.name === "remote-loopback") return event;
  }
  return await t.target
    .watchTurn(turn.sessionId, { startIndex: turn.session.state.streamIndex })
    .waitForEvent("agent.started", { data: { name: "remote-loopback" } });
}
