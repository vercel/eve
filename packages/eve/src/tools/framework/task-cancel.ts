import {
  TASK_CANCEL_INPUT_SCHEMA,
  TASK_VIEWS_OUTPUT_SCHEMA,
} from "#tools/framework/task-contract.js";
import { defineNativeTool } from "#tools/native-definition.js";

export const taskCancel = defineNativeTool(
  {
    description:
      "Request cooperative cancellation of one or more background tasks. Cancellation is final: a task that finishes after you cancel it stays cancelled. Cancelling an already-finished task changes nothing.",
    inputSchema: TASK_CANCEL_INPUT_SCHEMA,
    outputSchema: TASK_VIEWS_OUTPUT_SCHEMA,
  },
  {
    availability: ["root-session"],
    handling: { action: "task-cancel", kind: "dispatch" },
  },
);

export default taskCancel;
