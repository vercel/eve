import { defineEval } from "eve/evals";

export default defineEval({
  description: "A decision model routes each turn once, in any process, without model tool calls.",
  async test(t) {
    const first = await t.send("Alice needs a routine summary of the incident evidence.");
    first.expectOk();
    first.messageIncludes('"model":"openai/small"');
    first.messageIncludes('"reasoning":"low"');
    first.messageIncludes('"decisions":1');
    first.usedNoTools();
    const second = await first.session.send(
      "Bob now needs a difficult investigation of that incident.",
    );
    second.expectOk();
    second.usedNoTools();
    second.messageIncludes('"model":"openai/large"');
    second.messageIncludes('"reasoning":"high"');
    second.messageIncludes('"decisions":1');
    t.succeeded();
  },
});
