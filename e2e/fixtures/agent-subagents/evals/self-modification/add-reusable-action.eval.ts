import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "A request for a reusable agent action delegates to the self-modification subagent.",
  async test(t) {
    const started = await t.send(
      "Please add a reusable greeting action that you can call when Alice asks for a greeting in future conversations.",
    );
    started.expectOk();

    t.succeeded();
    t.calledSubagent("self-modification");
  },
});
