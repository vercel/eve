import { defineTool } from "eve/tools";
import { z } from "zod";
import { purchasingSheets } from "../../../../purchasing-sheets";

export default defineTool({
  description: "Wait for the purchasing review of one sheet and return its findings.",
  inputSchema: z.object({ sheet: z.number().int().min(1).max(5) }),
  async execute({ sheet }) {
    const startedAt = Date.now();
    // Keep reviews overlapping and let the parent acknowledge admission before
    // completion. The five children reach this tool within a few seconds of
    // each other; the eval logs the overlap margin so the wait can be tuned.
    await new Promise((resolve) => setTimeout(resolve, 15_000 + sheet * 1_500));
    return {
      sheet,
      ...purchasingSheets[sheet - 1]!,
      startedAt,
      completedAt: Date.now(),
    };
  },
});
