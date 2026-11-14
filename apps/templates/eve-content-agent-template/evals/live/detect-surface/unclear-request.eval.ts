import { defineEval } from "eve/evals";
import { asRecord } from "../../shared.js";

/**
 * A request that names no surface comes back as "ask the writer", not as a guess.
 */
export default defineEval({
  description: "detect_surface returns no surface for an ambiguous request.",
  async test(t) {
    await t.send(
      "Call detect_surface on this request and tell me what it returned, nothing else: " +
        '"Can you write something about our new export feature?"'
    );
    t.succeeded();
    t.calledTool("detect_surface", {
      output: (value) => {
        const { outcome, surface } = asRecord(value);
        return outcome === "unsure" && surface === null;
      },
    });
  },
});
