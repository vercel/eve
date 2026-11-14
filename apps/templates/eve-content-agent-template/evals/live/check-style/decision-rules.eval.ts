import { defineEval } from "eve/evals";
import { asRecord, checkStylePrompt } from "../../shared.js";

/**
 * A plain draft must be judged by the decision model, not by the error fallback.
 *
 * @remarks
 * Covers the `decide` stage of `check_style`. It asserts that the decision model answered every
 * rule (`checks` is populated) and that the tool did not fall back because the decision model
 * failed (`escalation` is not `decide_error`). It makes no claim about `ok`: a probability near
 * the uncertain band legitimately sends the draft to the reviewer.
 */
export default defineEval({
  description:
    "check_style gets answers from the decision model for a clean draft.",
  async test(t) {
    await t.send(
      checkStylePrompt(
        "# Export reports to a spreadsheet\n\nYou can now export any report to a " +
          "spreadsheet. Open the report, choose Export, and pick a format. The file downloads " +
          "in a few seconds and keeps your filters and column order."
      )
    );
    t.succeeded();
    t.calledTool("check_style", {
      output: (value) => {
        const { checks, escalation, violations } = asRecord(value);
        return (
          Array.isArray(checks) &&
          checks.length === 4 &&
          escalation !== "decide_error" &&
          Array.isArray(violations) &&
          violations.length === 0
        );
      },
    });
  },
});
