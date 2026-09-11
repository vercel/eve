import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description:
    "Capability installation questions proactively delegate to the self-modification subagent.",
  async test(t) {
    const started = await t.send("Are you able to install Linear for me?");
    started.expectOk();

    t.succeeded();
    t.calledSubagent("self-modification");
  },
});
