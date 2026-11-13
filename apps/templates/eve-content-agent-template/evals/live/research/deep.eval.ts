import { defineEval } from "eve/evals";
import { asRecord, hasFindings } from "../../shared.js";

/**
 * A question marked `deep` goes through the `research` tool and returns a cited finding.
 *
 * @remarks
 * The question is kept deliberately small: two named sources and one point of comparison. The
 * case exists to show that a `deep` request is routed and answered, not to exercise a long
 * research run, which costs real money on every eval.
 */
export default defineEval({
  description:
    "research returns a sourced finding for a narrow question marked deep.",
  async test(t) {
    await t.send(
      "Use the research tool once with depth `deep`, passing this question as the message " +
        'without adding to it: "According to RFC 9114 and RFC 9113, what is the one main ' +
        "difference in how HTTP/3 and HTTP/2 are affected by head-of-line blocking? Cite " +
        'only those two RFCs; two findings at most." Then report what it returned.'
    );
    t.succeeded();
    t.calledTool("research", {
      count: 1,
      input: (value) => asRecord(value).depth === "deep",
      output: hasFindings,
    });
  },
  timeoutMs: 180_000,
});
