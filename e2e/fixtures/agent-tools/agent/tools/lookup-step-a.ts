import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * First half of the chained tool pair used by the multi-step tool
 * loop eval (`evals/static-tools/multi-step-loop.eval.ts`).
 *
 * Returns a deterministic `stepKey` that `lookup-step-b` requires as
 * its input. The smoke test instructs the model to call this tool
 * first, then feed the returned `stepKey` into `lookup-step-b`,
 * which forces a deterministic 2-step tool loop. The unique tool
 * name and tightly-scoped description ensure no other smoke test
 * accidentally triggers this tool.
 */
export default defineTool({
  description:
    "Smoke-test fixture: returns a deterministic stepKey that must be passed into the `lookup-step-b` tool to retrieve the final value. Only call when the user explicitly asks to use `lookup-step-a`.",
  inputSchema: z.object({
    topic: z.string().min(1).describe("Any non-empty topic string."),
  }),
  async execute() {
    return { stepKey: "K-9F2X" };
  },
});
