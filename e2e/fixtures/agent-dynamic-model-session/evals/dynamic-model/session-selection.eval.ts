import { MOCK_MODEL_SENTINEL } from "@eve-e2e/config";
import { defineEval } from "eve/evals";

const requestedModel = process.env.EVE_E2E_MODEL;
const selectedModel =
  requestedModel === undefined || requestedModel === MOCK_MODEL_SENTINEL
    ? "openai/gpt-5.6-sol"
    : requestedModel;

export default defineEval({
  description: "A session-scoped dynamic model resolves once and remains selected across turns.",
  async test(t) {
    const first = await t.send(
      'Reply with exactly the text "session model turn one" and nothing else.',
    );
    first.expectOk();
    first.messageIncludes("session model turn one");
    first.eventsSatisfy("the session resolver selects the configured model", (events) =>
      events.some((event) => event.type === "step.started" && event.data.modelId === selectedModel),
    );

    const second = await t.send(
      'Reply with exactly the text "session model turn two" and nothing else.',
    );
    second.expectOk();
    second.messageIncludes("session model turn two");
    second.eventsSatisfy(
      "the second turn reuses the session selection",
      (events) =>
        events.some(
          (event) => event.type === "step.started" && event.data.modelId === selectedModel,
        ) && events.every((event) => event.type !== "session.started"),
    );

    t.succeeded();
    t.usedNoTools();
  },
});
