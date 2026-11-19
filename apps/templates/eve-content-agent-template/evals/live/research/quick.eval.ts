import { defineEval } from "eve/evals";
import { asRecord, hasFindings } from "../../shared.js";

/**
 * A single-fact question goes through the `research` tool and returns a cited finding.
 */
export default defineEval({
  description:
    "research returns at least one sourced finding for a quick factual question.",
  async test(t) {
    await t.send(
      "Use the research tool with depth `quick` to find the year the first version of the " +
        "HTTP/2 specification (RFC 7540) was published. Report the finding and its source URL."
    );
    t.succeeded();
    t.calledTool("research", {
      input: (value) => asRecord(value).depth === "quick",
      output: hasFindings,
    });
  },
});
