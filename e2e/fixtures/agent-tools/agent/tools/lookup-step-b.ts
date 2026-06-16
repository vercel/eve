import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Second half of the chained tool pair used by the multi-step tool
 * loop eval (`evals/static-tools/multi-step-loop.eval.ts`).
 *
 * Only the `stepKey` returned by `lookup-step-a` resolves to a
 * value; any other input is rejected so the test fails loudly if
 * the model skips the first step.
 */
export default defineTool({
  description:
    "Smoke-test fixture: returns the final value for a stepKey previously obtained from `lookup-step-a`. Only call when the user explicitly asks to use `lookup-step-b`.",
  inputSchema: z.object({
    stepKey: z
      .string()
      .min(1)
      .describe("The exact `stepKey` returned by a prior call to `lookup-step-a`."),
  }),
  async execute(input) {
    if (input.stepKey !== "K-9F2X") {
      return {
        ok: false,
        error: `Unknown stepKey ${JSON.stringify(input.stepKey)}. Call \`lookup-step-a\` first to obtain a valid stepKey.`,
      };
    }
    return { ok: true, value: "phoenix-rising-9F2X" };
  },
});
