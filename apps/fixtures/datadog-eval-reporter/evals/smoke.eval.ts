import { defineEval } from "eve/evals";

export default defineEval({
  description: "Datadog reporter smoke eval.",

  async test(t) {
    const turn = await t.send("Say hello.");
    turn.messageIncludes("Hello from the Datadog fixture.");
    t.succeeded();
  },
});
