import { defineEval } from "eve/evals";

export default defineEval({
  description: "Dynamic model smoke: a throwing resolver fails the turn.",
  async test(t) {
    const turn = await t.send("[model: boom] This turn must fail before a model call.");

    turn.eventsSatisfy("the turn reports the resolver exception", (events) =>
      events.some(
        (event) =>
          event.type === "turn.failed" &&
          event.data.message.includes("intentional resolver failure"),
      ),
    );
    turn.usedNoTools();
  },
});
