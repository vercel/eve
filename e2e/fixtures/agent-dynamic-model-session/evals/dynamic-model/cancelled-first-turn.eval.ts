import { MOCK_MODEL_SENTINEL } from "@eve-e2e/config";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TOOL_NAME = "wait-for-cancellation";
const requestedModel = process.env.EVE_E2E_MODEL;
const selectedModel =
  requestedModel === undefined || requestedModel === MOCK_MODEL_SENTINEL
    ? "openai/gpt-5.6-sol"
    : requestedModel;

export default defineEval({
  description: "A session-scoped dynamic model remains selected when the first turn is cancelled.",
  timeoutMs: 240_000,

  async test(t) {
    const live = await t.start(
      "Call the wait-for-cancellation tool and wait until this turn is cancelled.",
    );
    await live.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some((action) => action.kind === "tool-call" && action.toolName === TOOL_NAME),
      },
    });

    const cancelled = await live.cancel();
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) =>
          value.status === "accepted" && value.sessionId === live.sessionId,
        "the first-turn cancellation is accepted",
      ),
    );

    const cancelledTurn = await live.result();
    cancelledTurn.event("turn.cancelled", { count: 1 });
    cancelledTurn.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    cancelledTurn.notEvent("turn.failed");
    cancelledTurn.notEvent("session.failed");

    const resumed = await t.send(
      'Reply with exactly the text "session model after cancellation" and nothing else.',
    );
    resumed.expectOk();
    resumed.messageIncludes("session model after cancellation");
    resumed.eventsSatisfy(
      "the resumed turn reuses the session selection without restarting the session",
      (events) =>
        events.some(
          (event) => event.type === "step.started" && event.data.modelId === selectedModel,
        ) && events.every((event) => event.type !== "session.started"),
    );

    t.succeeded();
  },
});
