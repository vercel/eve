import { defineEval } from "eve/evals";

// The action.result stream event carries the RAW execute output
// (including the secret field), not the toModelOutput projection.
export default defineEval({
  description: "Dynamic tools smoke: action.result carries the raw execute output.",
  async test(t) {
    const turn = await t.send(
      "Use the `dynamic-model-output__check_model_output` tool with value 'hello' and tell me what the result contains.",
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("dynamic-model-output__check_model_output", {
      isError: false,
      output: { raw: true, secret: "internal-only-data", value: "hello" },
    });
  },
});
