import { defineTool } from "#public/definitions/tool.js";
import { TASK_CANCEL_INPUT_SCHEMA, TASK_VIEWS_OUTPUT_SCHEMA } from "#shared/task-tool.js";

/** The harness intercepts this tool before its durable dispatch step executes. */
export const taskCancel = defineTool({
  description:
    "Request cooperative cancellation of one or more background tasks. Cancellation is final: a task that finishes after you cancel it stays cancelled. Cancelling an already-finished task changes nothing.",
  inputSchema: TASK_CANCEL_INPUT_SCHEMA,
  outputSchema: TASK_VIEWS_OUTPUT_SCHEMA,
  execute() {
    throw new Error("task_cancel is handled by eve's durable dispatch step.");
  },
});

export default taskCancel;
