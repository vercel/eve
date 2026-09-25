import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "Requests to connect to a named service delegate to the self-modification subagent.",
  async test(t) {
    const started = await t.send("Can you connect to Salesforce for me?");
    started.expectOk();

    t.succeeded();
    t.calledSubagent("self-modification");
  },
});
