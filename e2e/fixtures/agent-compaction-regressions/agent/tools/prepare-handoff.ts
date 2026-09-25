import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { handoffNotes } from "../../release-findings";
import { HANDOFF_REFERENCE, releaseRecords, saveReleaseRecord } from "../../release-reports";

const invocationCount = defineState("storefront.prepare-handoff", () => 0);

export default defineTool({
  description: "Prepare a release handoff from a completed storefront review record.",
  inputSchema: z.object({
    reviewId: z.string().min(1),
  }),
  async execute(input) {
    const review = releaseRecords.get()[input.reviewId];
    if (review?.status !== "completed") {
      throw new Error("Complete the requested review before preparing its release handoff.");
    }
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);
    const report = {
      reportId: HANDOFF_REFERENCE,
      status: "completed" as const,
      findings: handoffNotes,
    };
    saveReleaseRecord(report);
    return {
      completed: true,
      reviewId: review.reportId,
      ...report,
      attempt,
      hardStop: attempt >= 10,
    };
  },
});
