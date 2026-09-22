import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { repositoryFindings } from "../../release-findings";
import { REVIEW_REFERENCE, saveReleaseRecord } from "../../release-reports";

const invocationCount = defineState("storefront.inspect-repository", () => 0);

export default defineTool({
  description: "Review the storefront repository and save a completed review record.",
  inputSchema: z.object({ scope: z.literal("repository") }),
  async execute() {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);
    const report = {
      reportId: REVIEW_REFERENCE,
      status: "completed" as const,
      findings: repositoryFindings,
    };
    saveReleaseRecord(report);
    return { completed: true, ...report, attempt, hardStop: attempt >= 10 };
  },
});
