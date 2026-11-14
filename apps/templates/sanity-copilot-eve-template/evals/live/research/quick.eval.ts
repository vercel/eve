import { defineEval } from "eve/evals";
import { asRecord, hasFindings } from "../../shared.js";

/**
 * A single-fact question goes through the `research` tool and returns a cited finding.
 *
 * @remarks
 * Also the only check that the researcher's web search works at runtime. The prompt is narrow
 * and the call count is pinned to one to keep the run cheap.
 */
export default defineEval({
  description:
    "research returns at least one sourced finding for a quick factual question.",
  async test(t) {
    await t.send(
      "Call the research tool exactly once, with depth `quick`, passing this question as " +
        "written: In which year was RFC 7540, the first HTTP/2 specification, published? " +
        "Don't call any other tool. Report the finding and its source URL."
    );
    t.succeeded();
    t.calledTool("research", {
      count: 1,
      input: (value) => asRecord(value).depth === "quick",
      output: hasFindings,
    });
  },
  timeoutMs: 180_000,
});
