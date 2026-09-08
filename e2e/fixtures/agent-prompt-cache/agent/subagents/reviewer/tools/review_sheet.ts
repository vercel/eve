import { defineTool } from "eve/tools";
import { z } from "zod";
import { purchasingSheets } from "../../../../purchasing-sheets";

export default defineTool({
  description: "Wait for the purchasing review of one sheet and return its findings.",
  inputSchema: z.object({ sheet: z.number().int().min(1).max(5) }),
  async execute({ sheet }) {
    const startedAt = Date.now();
    // Keep reviews overlapping and let the parent acknowledge admission before completion.
    await new Promise((resolve) => setTimeout(resolve, 30_000 + sheet * 3_000));
    return {
      sheet,
      findings: purchasingSheets[sheet - 1]!.findings,
      startedAt,
      completedAt: Date.now(),
    };
  },
});
