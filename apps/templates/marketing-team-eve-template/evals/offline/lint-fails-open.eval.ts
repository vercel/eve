import { defineEval } from "eve/evals";
import { toolScript } from "../shared.js";

/**
 * Protects the fail-open contract of the decision-model layer in `lint_against_style`.
 *
 * @remarks
 * Offline no decision model answers, which is the same path a provider outage takes. The lint must
 * still report its banned-word hits with `judged: false` instead of failing the call. The tool
 * belongs to a specialist, so the script is sent through a delegation.
 */
export default defineEval({
  description:
    "lint_against_style still reports banned words when no decision model answers.",
  async test(t) {
    await t.send(
      toolScript("email", {
        message: toolScript("lint_against_style", {
          surface: "email",
          text: "Act now to leverage this exclusive offer.",
        }),
      })
    );
    t.calledAgent("email", {
      output: (value) => {
        const text =
          typeof value === "string" ? value : String(JSON.stringify(value));
        return (
          text.includes('"judged":false') &&
          text.includes('"ok":false') &&
          text.includes("leverage")
        );
      },
    });
  },
});
