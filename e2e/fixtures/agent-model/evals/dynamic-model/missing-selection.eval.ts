import { defineEval } from "eve/evals";

export default defineEval({
  description: "Dynamic model smoke: a missing selection fails the turn.",
  async test(t) {
    const turn = await t.send("[model: missing] This turn must fail before a model call.");

    turn.eventsSatisfy("the turn reports a missing dynamic model selection", (events) =>
      events.some(
        (event) =>
          event.type === "turn.failed" &&
          event.data.message.includes("Dynamic model resolver returned no model"),
      ),
    );
    turn.usedNoTools();
  },
});
