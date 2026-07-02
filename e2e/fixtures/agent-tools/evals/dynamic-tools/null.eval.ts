import { defineEval } from "eve/evals";

// A resolver returning null must register no tools: the turn completes
// without any "dynamic-null" call.
export default defineEval({
  description: "Dynamic tools smoke: a null-returning resolver registers no tools.",
  async test(t) {
    await t.send(
      "List every tool you have access to. Is there a tool called 'dynamic-null'? Answer yes or no.",
    );

    t.succeeded();
    t.notCalledTool("dynamic-null");
  },
});
