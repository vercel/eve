import { defineEval } from "eve/evals";

/**
 * Source material handed to the agent in the prompt, so the case never needs Notion.
 */
const SOURCE = [
  "Product: Reports. Change: one-click export to CSV and XLSX, available today on every plan.",
  "Exports keep the report's filters and column order. Files over 50,000 rows are emailed.",
  "Customer quote (Dana, ops lead at Northwind): 'Month-end close went from two days to one.'",
].join("\n");

/**
 * A drafted LinkedIn post is graded against the surface's rules by the decision model.
 *
 * @remarks
 * The other evals check that tools ran; this one checks that the draft is any good. It catches
 * regressions when someone edits a style skill or the agent's instructions.
 */
export default defineEval({
  description:
    "A LinkedIn draft from fixed source text reads well and stays on the facts.",
  async test(t) {
    const turn = await t.send(
      "Draft a LinkedIn post announcing this, using only these facts. Don't ask me anything; " +
        `post the draft in your reply.\n\n${SOURCE}`
    );
    t.succeeded();
    t.calledSkill("linkedin-style");
    t.calledTool("check_style");

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
        shaped: {
          instructions:
            "Is the draft shaped like a LinkedIn post: a strong opening line, short " +
            "paragraphs, and under 3,000 characters?",
          type: "boolean",
        },
      },
      state: { draft: turn.reply ?? "", source: SOURCE },
    });
    judgments.grounded.atLeast(0.8);
    judgments.plain.atLeast(0.7);
    judgments.shaped.atLeast(0.7);
  },
});
