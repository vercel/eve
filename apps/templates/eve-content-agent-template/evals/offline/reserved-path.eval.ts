import { defineEval } from "eve/evals";
import { asRecord, toolScript } from "../shared.js";

/**
 * The asset tools refuse the Blob prefix that holds writer memory.
 */
export default defineEval({
  description: "upload_asset refuses a reserved path without touching storage.",
  async test(t) {
    await t.send(
      toolScript("upload_asset", {
        content: "not a preference",
        pathname: "eve/memory/file/someone-else.md",
      })
    );
    t.calledTool("upload_asset", {
      output: (value) => {
        const { error, success } = asRecord(value);
        return success === false && String(error).includes("reserved");
      },
    });
  },
});
