import { defineTool } from "eve/tools";
import { z } from "zod";
import { record } from "../../src/audit.ts";
import { reportSchema } from "../../src/report-schema.ts";

export default defineTool({
  description:
    "Save an orders or treasury report. Amounts are integer USD cents. Returns { saved: true }.",
  inputSchema: reportSchema,
  outputSchema: z.object({ saved: z.boolean() }),
  async execute(input, ctx) {
    return record(ctx, input, () => ({ saved: true }));
  },
});
