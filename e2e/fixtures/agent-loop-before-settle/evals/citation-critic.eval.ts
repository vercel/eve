import { defineEval } from "eve/evals";

export default defineEval({
  description: "beforeSettle sends an uncited reply back to the model, and the turn settles once.",
  async test(t) {
    const session = await t.session();
    const turn = await session.send("Alice asks which sources back the second claim in her draft.");
    turn.expectOk();
    turn.event("model.started", { count: 2 });
    turn.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    turn.messageIncludes("[1]");
  },
});
