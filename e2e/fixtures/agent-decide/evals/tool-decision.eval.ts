import { defineEval } from "eve/evals";

export default defineEval({
  description: "A tool decides structured state and returns typed answers and usage.",
  async test(t) {
    const turn = await t.send(
      "Alice uses decide-request to choose a model for her routine summary.",
    );
    turn.expectOk();
    turn.calledTool("decide-request");
    turn.messageIncludes('"isError":false');
    turn.messageIncludes('"choice":"openai/small"');
    turn.messageIncludes('"totalTokens":45');
    t.succeeded();
  },
});
