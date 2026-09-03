import { TASK_UPDATE_INPUT_SCHEMA } from "#tools/framework/task-contract.js";
import { defineNativeTool } from "#tools/native-definition.js";

export const TASK_UPDATE_SESSION_INSTRUCTION =
  "Background task updates\nYou are running as a background task. For multi-step work, use `task_update` at meaningful milestones to briefly state what you are currently doing. Keep updates terse and activity-focused; do not include preliminary findings or results. Do not wait for a response, and return your final result normally.";

export const taskUpdate = defineNativeTool(
  {
    description:
      "Briefly tell the parent agent what this background task is currently doing. Report activity, not preliminary findings or results.",
    inputSchema: TASK_UPDATE_INPUT_SCHEMA,
  },
  {
    availability: ["delegated-task-child"],
    handling: { action: "task-update", kind: "dispatch" },
  },
);

export default taskUpdate;
