import { z } from "#compiled/zod/index.js";

import { reportProgress } from "#execution/report-progress.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";

export const REPORT_PROGRESS_TOOL: HarnessToolDefinition = {
  description:
    "Update the user-visible progress status without notifying or steering the parent agent.",
  execute: async (input, options) =>
    await reportProgress({ callId: options.toolCallId, message: input.message }),
  inputSchema: z.object({
    message: z.string().min(1).describe("Brief description of the work currently in progress."),
  }),
  name: "report_progress",
};
