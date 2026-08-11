import { defineEval } from "eve/evals";

const model = process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol";

export default defineEval({
  tags: ["real-model"],
  description: "Dynamic model smoke: runtime catalog metadata is reusable across turns.",
  async test(t) {
    const first = await t.send(
      '[model: catalog] Reply with exactly the text "catalog one" and nothing else.',
    );
    first.expectOk();
    first.messageIncludes("catalog one");

    const second = await t.send(
      '[model: catalog] Reply with exactly the text "catalog two" and nothing else.',
    );
    second.expectOk();
    second.messageIncludes("catalog two");
    second.eventsSatisfy("the model call is attributed to the selected model", (events) =>
      events.some((event) => event.type === "step.started" && event.data.modelId === model),
    );

    t.succeeded();
    t.usedNoTools();
  },
});
