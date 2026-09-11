import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "Requests to enable a named service delegate to the self-modification subagent.",
  async test(t) {
    const started = await t.send("Can you enable GitHub access for this agent?");
    started.expectOk();

    t.succeeded();
    t.calledSubagent("self-modification");
  },
});
