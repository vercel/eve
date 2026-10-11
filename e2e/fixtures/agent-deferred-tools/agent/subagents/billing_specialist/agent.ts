import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

/** A deferred subagent: the root reaches it through search and execute. */
export default defineAgent({
  ...e2eSubagentConfig({
    mock: ({ userMessages }) =>
      userMessages.some((message) => message.includes("Review Bob's dispute DSP-17."))
        ? "SPECIALIST-REVIEW: refund DSP-17"
        : "SPECIALIST-REVIEW: no dispute named",
  }),
  description: "Review billing disputes and recommend a resolution.",
  tool: "deferred",
});
