import { defineEval } from "eve/evals";
import { asRecord } from "../../shared.js";

/**
 * A request that plainly describes a surface is detected without asking the writer.
 */
export default defineEval({
  description: "detect_surface names the surface for an unambiguous request.",
  async test(t) {
    await t.send(
      "Call detect_surface on this request and tell me what it returned, nothing else: " +
        '"Write up what changed in version 2.4 for our changelog."'
    );
    t.succeeded();
    t.calledTool("detect_surface", {
      output: (value) => {
        const { outcome, surface } = asRecord(value);
        return outcome === "confident" && surface === "release-notes";
      },
    });
  },
});
