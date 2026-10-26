import { defineEval } from "eve/evals";

export default defineEval({
  description: "A throwing model function fails the turn before any provider call.",
  async test(t) {
    const turn = await t.send("[model: boom] This turn must fail before a model call.");

    turn.eventsSatisfy("the turn reports the resolver exception", (events) =>
      events.some(
        (event) =>
          event.type === "turn.settled" &&
          event.data.outcome === "failed" &&
          event.data.error?.code === "REACTION_FAILED" &&
          event.data.error?.message.includes("intentional resolver failure"),
      ),
    );
    turn.notEvent("model.started");
    turn.usedNoTools();
  },
});
