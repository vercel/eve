import { defineEval } from "eve/evals";

export default defineEval({
  description: "An evaluation model routes each turn once without model tool calls.",
  async test(t) {
    const first = await t.send("Alice needs a routine summary of the incident evidence.");
    first.expectOk();
    first.messageIncludes('"model":"openai/small"');
    first.messageIncludes('"reasoning":"low"');
    first.messageIncludes('"requests":1');
    first.usedNoTools();
    const second = await t.send("Bob now needs a difficult investigation of that incident.");
    second.expectOk();
    second.usedNoTools();
    second.messageIncludes('"model":"openai/large"');
    second.messageIncludes('"reasoning":"high"');
    second.messageIncludes('"requests":2');
    t.succeeded();
  },
});
