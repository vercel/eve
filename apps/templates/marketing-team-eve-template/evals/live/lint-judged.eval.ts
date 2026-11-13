import { defineEval } from "eve/evals";

/**
 * Confirms the decision model answers inside `lint_against_style` on real models.
 *
 * @remarks
 * `judgeRules` fails open, so a blocked provider or a wrong model id produces no error anywhere:
 * the lint just stops judging. This case is the only signal. It is pinned to one delegation and
 * one tool call to keep a live run short and cheap.
 */
export default defineEval({
  description:
    "lint_against_style gets answers from the decision model, which fails open and is otherwise " +
    "invisible.",
  async test(t) {
    await t.send(
      "Tool test, so skip brand context. Delegate once to the email specialist with this brief: " +
        "'Tool test only. Call lint_against_style once with surface email on the text \"Your " +
        'March invoice is ready. Open the billing page to download it." and no other tool. ' +
        "Reply with exactly JUDGED=true or JUDGED=false, matching the judged field.' Then " +
        "repeat its reply exactly."
    );
    t.succeeded();
    t.calledAgent("email");
    t.messageIncludes("JUDGED=true");
  },
});
