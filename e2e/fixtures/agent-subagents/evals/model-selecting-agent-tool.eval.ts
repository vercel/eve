import {
  isCurrentTurnBoundaryEvent,
  type AgentStartedStreamEvent,
  type MessageStreamEvent,
} from "eve/client";
import { defineEval, type EveEvalContext, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { MODEL_AGENT_SELECTED_MODEL } from "../constants";

export default defineEval({
  description:
    "An opt-in custom agent tool selects a child model while the default agent tool keeps its original input.",
  async test(t) {
    const turn = await t.send(
      "E2E_MODEL_SELECTING_AGENT_TOOL Alice asks two root copies to review the same sample plan.",
    );

    turn.expectOk();
    turn.messageIncludes("DEFAULT_AGENT_MODEL_OK");
    turn.messageIncludes("SELECTED_AGENT_MODEL_OK");
    turn.calledTool("model_agent", {
      count: 1,
      input: {
        message: "Reply with exactly SELECTED_AGENT_MODEL_OK",
        model: MODEL_AGENT_SELECTED_MODEL,
      },
    });

    const started = await requireSelectedChild(t, turn);
    const childEvents: MessageStreamEvent[] = [];
    for await (const event of turn.session.agent(started).stream()) {
      childEvents.push(event);
      if (isCurrentTurnBoundaryEvent(event)) break;
    }

    await t.require(
      childEvents,
      satisfies(
        (events: readonly MessageStreamEvent[]) =>
          events.some(
            (event) =>
              event.type === "step.started" && event.data.modelId === MODEL_AGENT_SELECTED_MODEL,
          ),
        `the custom agent tool starts its child with ${MODEL_AGENT_SELECTED_MODEL}`,
      ),
    );
    t.succeeded();
    t.noFailedActions();
  },
});

async function requireSelectedChild(
  t: EveEvalContext,
  turn: EveEvalTurn,
): Promise<AgentStartedStreamEvent> {
  for (const event of turn.events) {
    if (event.type === "agent.started" && event.data.callId === "model-agent-call") return event;
  }
  return await t.target
    .watchTurn(turn.sessionId, { startIndex: turn.session.state.streamIndex })
    .waitForEvent("agent.started", { data: { callId: "model-agent-call" } });
}
