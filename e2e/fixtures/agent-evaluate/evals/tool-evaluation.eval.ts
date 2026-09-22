import { defineEval } from "eve/evals";

export default defineEval({
  description: "A tool evaluates structured state and returns typed answers and usage.",
  async test(t) {
    const turn = await t.send(
      "Alice uses evaluate-request to choose a model for her routine summary.",
    );
    turn.expectOk();
    turn.calledTool("evaluate-request");
    turn.messageIncludes('"isError":false');
    turn.messageIncludes('"choice":"openai/small"');
    turn.messageIncludes('"totalTokens":45');
    t.succeeded();
  },
});
