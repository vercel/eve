import { defineEval } from "eve/evals";
import { asRecord, checkStylePrompt } from "../../shared.js";

/**
 * A draft containing a banned word must come back with that word in `violations`.
 *
 * @remarks
 * Covers the deterministic stage of `check_style`: "leverage" is on the blog banned-words list,
 * so the regex pass flags it whatever the decision model or reviewer conclude.
 */
export default defineEval({
  description: "check_style reports a banned word found in a blog draft.",
  async test(t) {
    await t.send(
      checkStylePrompt(
        "Teams can leverage our new export feature to move reports into a spreadsheet in one " +
          "click. It is available today on every plan."
      )
    );
    t.succeeded();
    t.calledTool("check_style", {
      output: (value) => {
        const { ok, violations } = asRecord(value);
        return (
          ok === false &&
          Array.isArray(violations) &&
          violations.some((note) => String(note).includes("leverage"))
        );
      },
    });
  },
});
