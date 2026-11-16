import { defineEval } from "eve/evals";

/**
 * Source material handed to the agent in the prompt, so the case never needs Sanity or Notion.
 */
const SOURCE = [
  "Product: Reports. Change: one-click export to CSV and XLSX, available today on every plan.",
  "Exports keep the report's filters and column order. Files over 50,000 rows are emailed.",
  "Customer quote (Dana, ops lead at Northwind): 'Month-end close went from two days to one.'",
].join("\n");

/**
 * A short drafted announcement is graded by the decision model for grounding and plain English.
 *
 * @remarks
 * The other evals check that tools ran; this one checks that the draft is any good. It catches
 * regressions when someone edits the `writing-quality` skill or the agent's instructions.
 */
export default defineEval({
  description:
    "A short announcement drafted from fixed source text is plain and stays on the facts.",
  async test(t) {
    const turn = await t.send(
      "Draft a three-paragraph blog announcement for this, using only these facts. Don't " +
        "query Sanity or Notion, don't run research or a review, and don't ask me anything; " +
        `put the draft in your reply.\n\n${SOURCE}`
    );
    t.succeeded();
    t.calledSkill("writing-quality");

    const judgments = t.judge({
      questions: {
        grounded: {
          instructions:
            "Does the draft state only facts found in the source, with no invented numbers, " +
            "features, or quotes?",
          type: "boolean",
        },
        plain: {
          instructions:
            "Is the draft written in plain, concrete English, free of marketing clichés and " +
            "AI-sounding filler?",
          type: "boolean",
        },
      },
      state: { draft: turn.reply ?? "", source: SOURCE },
    });
    judgments.grounded.atLeast(0.8);
    judgments.plain.atLeast(0.7);
  },
  timeoutMs: 240_000,
});
