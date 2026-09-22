import { defineEval } from "eve/evals";

export default defineEval({
  description: "A live Jev request classifies instrumentation state and reaches its handler.",
  tags: ["real-model"],
  async test(t) {
    const turn = await t.send(
      "Alice runs the jev-classification check for a restricted support record.",
    );

    turn.expectOk();
    turn.usedNoTools();
    turn.messageIncludes(
      '"classification":{"observed":"restricted","requests":1,"result":"restricted"}',
    );
    t.succeeded();
  },
});
