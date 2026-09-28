import { createHash } from "node:crypto";

import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

/** A task: compiling takes long enough that the conversation can move on meanwhile. */
export default defineWorkflowTool({
  description:
    "Compile one of the team's reports, such as the churn or latency report. Takes about ten seconds; returns the report id and its headline.",
  inputSchema: z.object({
    topic: z.string().describe("What the report covers, such as churn or latency."),
  }),
  async task({ topic }) {
    "use workflow";

    await sleep("10s");
    return await summarizeReport(topic);
  },
});

/** The report id is derived from the topic, so evals can match it against the result. */
async function summarizeReport(topic: string) {
  "use step";

  const digest = createHash("sha256").update(topic.trim().toLowerCase()).digest("hex");
  return {
    headline: `The ${topic} report is ready for Monday's review.`,
    reportId: `RPT-${digest.slice(0, 6).toUpperCase()}`,
    topic,
  };
}
