import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "Requests to add a named service delegate to the self-modification subagent.",
  async test(t) {
    const started = await t.send("Can you add Notion to this agent?");
    started.expectOk();

    t.succeeded();
    t.calledSubagent("self-modification");
  },
});
