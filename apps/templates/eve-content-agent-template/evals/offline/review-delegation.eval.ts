import { defineEval } from "eve/evals";
import { asRecord, toolScript } from "../shared.js";

/**
 * The `review` tool reaches the reviewer and returns its structured verdict.
 */
export default defineEval({
  description: "review returns the reviewer's verdict.",
  async test(t) {
    await t.send(
      toolScript("review", {
        message: "Surface: blog\n\nDraft:\nExport reports in one click.",
      })
    );
    t.succeeded();
    t.calledTool("review", {
      output: (value) => asRecord(value).verdict === "ready",
    });
  },
});
