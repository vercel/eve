import { TASK_UPDATE_INPUT_SCHEMA } from "#tools/framework/task-contract.js";
import { defineNativeTool } from "#tools/native-definition.js";

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
