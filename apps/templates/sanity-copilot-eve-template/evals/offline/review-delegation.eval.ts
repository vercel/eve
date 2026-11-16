import { defineEval } from "eve/evals";
import { asRecord, toolScript } from "../shared.js";

/**
 * The `review_draft` tool reaches the reviewer and returns its structured verdict.
 */
export default defineEval({
  description: "review_draft returns the reviewer's verdict.",
  async test(t) {
    await t.send(
      toolScript("review_draft", {
        message: "Draft:\nExport reports in one click.",
      })
    );
    t.succeeded();
    t.calledTool("review_draft", {
      output: (value) => asRecord(value).verdict === "ready",
    });
  },
});
