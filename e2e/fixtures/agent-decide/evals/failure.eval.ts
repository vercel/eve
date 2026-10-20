import { defineEval } from "eve/evals";

export default defineEval({
  description: "An unavailable decision model fails routing before any LLM or tool call.",
  async test(t) {
    const turn = await t.send("Alice records the service unavailable incident for review.");
    turn.eventsSatisfy("routing failure is reported", (events) =>
      events.some(
        (event) =>
          event.type === "turn.settled" &&
          event.data.outcome === "failed" &&
          event.data.error?.message.includes("Decision service unavailable"),
      ),
    );
    turn.usedNoTools();
  },
});
