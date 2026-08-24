import { z } from "#compiled/zod/index.js";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";

export const TASK_UPDATE_TOOL_NAME = "task_update";

export const TASK_UPDATE_INPUT_SCHEMA = z.strictObject({
  message: z.string().min(1).describe("Brief description of what this task is currently doing."),
});

export const TASK_UPDATE_DESCRIPTION =
  "Briefly tell the parent agent what this background task is currently doing. " +
  "Report activity, not preliminary findings or results.";

export function createTaskUpdateHarnessDefinition(): HarnessToolDefinition {
  return {
    description: TASK_UPDATE_DESCRIPTION,
    inputSchema: TASK_UPDATE_INPUT_SCHEMA,
    name: TASK_UPDATE_TOOL_NAME,
    runtimeAction: { kind: "task-control" },
  };
}
