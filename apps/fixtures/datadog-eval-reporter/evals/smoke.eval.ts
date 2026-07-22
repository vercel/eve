import { defineEval } from "eve/evals";

export default defineEval({
  description: "Datadog reporter smoke eval.",

  async test(t) {
    await t.send("Say hello.");

    t.succeeded();
    t.messageIncludes("Hello from the Datadog eval fixture.");
  },
});
