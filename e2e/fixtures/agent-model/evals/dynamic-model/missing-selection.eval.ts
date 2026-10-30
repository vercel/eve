import { defineEval } from "eve/evals";

export default defineEval({
  description: "A missing dynamic model selection fails the turn before any provider call.",
  async test(t) {
    const turn = await t.send("[model: missing] This turn must fail before a model call.");

    turn.eventsSatisfy("the turn reports a missing dynamic model selection", (events) =>
      events.some(
        (event) =>
          event.type === "turn.settled" &&
          event.data.outcome === "failed" &&
          event.data.error?.code === "REACTION_FAILED" &&
          event.data.error?.message.includes("The dynamic model returned no model"),
      ),
    );
    turn.notEvent("model.started");
    turn.usedNoTools();
  },
});
