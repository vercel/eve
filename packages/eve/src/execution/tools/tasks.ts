import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  TASK_CANCEL_INPUT_SCHEMA,
  TASK_CANCEL_TOOL_NAME,
  TASK_VIEWS_OUTPUT_SCHEMA,
} from "#tools/framework/task-contract.js";

/** Builds the harness definition for the compiled framework task control. */
export function createTaskToolHarnessDefinitions(): readonly HarnessToolDefinition[] {
  return [
    {
      description:
        "Request cooperative cancellation of one or more background tasks. " +
        "Cancellation is final: a task that finishes after you cancel it stays cancelled. Cancelling an already-finished task changes nothing.",
      inputSchema: TASK_CANCEL_INPUT_SCHEMA,
      name: TASK_CANCEL_TOOL_NAME,
      outputSchema: TASK_VIEWS_OUTPUT_SCHEMA,
      runtimeAction: { kind: "task-control" },
    },
  ];
}
