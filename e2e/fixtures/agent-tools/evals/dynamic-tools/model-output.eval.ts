import { defineEval } from "eve/evals";

// The action.result stream event carries the RAW execute output
// (including the secret field), not the toModelOutput projection.
export default defineEval({
  description: "Dynamic tools smoke: model output carries a file and action.result stays raw.",
  async test(t) {
    await t.send(
      "Use the `check_model_output` tool with value 'hello', inspect its attached image, and reply with the dominant color.",
    );

    t.succeeded();
    t.messageIncludes(/\bred\b/iu);
    t.calledTool("check_model_output", {
      output: { raw: true, secret: "internal-only-data", value: "hello" },
    });
  },
});
