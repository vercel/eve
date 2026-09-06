import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { todo } from "eve/tools/todo";
import { z } from "zod";

import { checkoutFindings } from "../../release-findings";
import { reviewReferences, saveReleaseRecord } from "../../release-reports";

const invocationCount = defineState("storefront.perform-source-analysis", () => 0);

export default defineTool({
  description: "Review the checkout implementation and save a completed review record.",
  inputSchema: z.object({ scope: z.literal("checkout") }),
  async execute(_input, ctx) {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);
    await todo.execute(
      {
        todos: [{ content: "Review checkout implementation", priority: "high", status: "pending" }],
      },
      ctx,
    );
    const report = {
      reportId: reviewReferences.checkout,
      subject: "checkout" as const,
      status: "completed" as const,
      findings: checkoutFindings,
    };
    saveReleaseRecord(report);
    return { completed: true, ...report, attempt, hardStop: attempt >= 10 };
  },
});
