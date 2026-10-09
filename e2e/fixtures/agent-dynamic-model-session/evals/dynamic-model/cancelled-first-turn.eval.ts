import { MOCK_MODEL_SENTINEL } from "@eve-e2e/config";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TOOL_NAME = "wait-for-cancellation";
const requestedModel = process.env.EVE_E2E_MODEL;
const selectedModel =
  requestedModel === undefined || requestedModel === MOCK_MODEL_SENTINEL
    ? "openai/gpt-6.1-sol"
    : requestedModel;

export default defineEval({
  description: "A session-scoped dynamic model remains selected when the first turn is cancelled.",
  timeoutMs: 240_000,

  async test(t) {
    const session = await t.session();
    const live = await session.start(
      "Call the wait-for-cancellation tool and wait until this turn is cancelled.",
    );
    await live.waitForEvent("call.requested", { data: { capability: { name: TOOL_NAME } } });

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
    cancelledTurn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    cancelledTurn.eventOrder([{ data: { outcome: "cancelled" }, type: "turn.settled" }]);
    cancelledTurn.notEvent("turn.settled", { data: { outcome: "failed" } });
    cancelledTurn.notEvent("session.ended", { data: { outcome: "failed" } });

    const resumed = await session.send(
      'Reply with exactly the text "session model after cancellation" and nothing else.',
    );
    resumed.expectOk();
    resumed.messageIncludes("session model after cancellation");
    resumed.eventsSatisfy(
      "the resumed turn reuses the session selection without restarting the session",
      (events) =>
        events.some(
          (event) => event.type === "model.started" && event.data.modelId === selectedModel,
        ) && events.every((event) => event.type !== "session.started"),
    );

    t.succeeded();
  },
});
