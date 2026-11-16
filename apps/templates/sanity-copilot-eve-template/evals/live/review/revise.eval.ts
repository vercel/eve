import { defineEval } from "eve/evals";
import { asRecord } from "../../shared.js";

/**
 * A short draft full of stock AI phrasing, so the reviewer has clear rules to cite.
 */
const DRAFT = [
  "In today's fast-paced digital landscape, it's important to note that content is king.",
  "Let's delve into how our robust, seamless platform empowers teams to unlock their potential.",
  "In conclusion, the possibilities are truly endless.",
].join(" ");

/**
 * The reviewer reads its rubric and sends a draft with obvious AI-tells back for revision.
 */
export default defineEval({
  description:
    "review_draft returns `revise` with at least one issue for a draft full of AI-tells.",
  async test(t) {
    await t.send(
      "Call the review_draft tool exactly once on this draft, exactly as written. Don't " +
        "rewrite it or call any other tool; report the verdict it returned.\n\n" +
        `Draft:\n${DRAFT}`
    );
    t.succeeded();
    t.calledTool("review_draft", {
      count: 1,
      output: (value) => {
        const { issues, verdict } = asRecord(value);
        return (
          verdict === "revise" && Array.isArray(issues) && issues.length > 0
        );
      },
    });
  },
  timeoutMs: 180_000,
});
