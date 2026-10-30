import { endsTurn, type SessionStreamEvent } from "eve/client";
type ChildOpened = Extract<SessionStreamEvent, { type: "child.opened" }>;
import { defineEval, type EveEvalTurn } from "eve/evals";
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

    const opened = requireSelectedChild(turn);
    const childEvents: SessionStreamEvent[] = [];
    for await (const event of turn.session.agent(opened).stream()) {
      childEvents.push(event);
      if (endsTurn(event)) break;
    }

    await t.require(
      childEvents,
      satisfies(
        (events: readonly SessionStreamEvent[]) =>
          events.some(
            (event) =>
              event.type === "model.started" && event.data.modelId === MODEL_AGENT_SELECTED_MODEL,
          ),
        `the custom agent tool starts its child with ${MODEL_AGENT_SELECTED_MODEL}`,
      ),
    );
    t.succeeded();
    t.noFailedCalls();
  },
});

// The child that the custom agent call opened: a task-backed call still owns its child by call id.
function requireSelectedChild(turn: EveEvalTurn): ChildOpened {
  const call = turn.events.find(
    (event) => event.type === "call.requested" && event.data.capability.name === "model_agent",
  );
  if (call?.type !== "call.requested") throw new Error("The custom agent call was not requested.");
  const opened = turn.events.find(
    (event) =>
      event.type === "child.opened" &&
      "callId" in event.data.owner &&
      event.data.owner.callId === call.data.callId,
  );
  if (opened?.type !== "child.opened")
    throw new Error(`The custom agent call ${call.data.callId} opened no child in its turn.`);
  return opened;
}
