import { defineEval } from "eve/evals";

// The action.result stream event carries the RAW execute output
// (including the secret field), not the toModelOutput projection.
export default defineEval({
  description: "Dynamic tools smoke: action.result carries the raw execute output.",
  async test(t) {
    await t.send(
      "Use the `check_model_output` tool with value 'hello' and tell me what the result contains.",
    );

    t.succeeded();
    t.calledTool("check_model_output", {
      output: { raw: true, secret: "internal-only-data", value: "hello" },
    });
  },
});
