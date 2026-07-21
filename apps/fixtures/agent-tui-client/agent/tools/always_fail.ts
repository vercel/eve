import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: never(),
  description: "Always throws. Exercises the tool-failure diagnostic path in the dev TUI.",
  inputSchema: z.object({
    reason: z.string().optional(),
  }),
  execute(input): never {
    throw new Error(`always_fail: ${input.reason ?? "intentional failure for diagnostics"}`);
  },
});
