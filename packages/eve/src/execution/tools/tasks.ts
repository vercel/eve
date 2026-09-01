import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  TASK_CANCEL_INPUT_SCHEMA,
  TASK_CANCEL_TOOL_NAME,
  TASK_UPDATE_INPUT_SCHEMA,
  TASK_UPDATE_TOOL_NAME,
  TASK_VIEWS_OUTPUT_SCHEMA,
} from "#tools/framework/task-contract.js";

/** Framework controls for durable background tasks. */

const TASK_CANCEL_DESCRIPTION =
  "Request cooperative cancellation of one or more background tasks. " +
  "Cancellation is final: a task that finishes after you cancel it stays cancelled. Cancelling an already-finished task changes nothing.";

const TASK_UPDATE_DESCRIPTION =
  "Briefly tell the parent agent what this background task is currently doing. " +
  "Report activity, not preliminary findings or results.";

/**
 * Builds harness definitions for the compiled framework task tools.
 */
export function createTaskToolHarnessDefinitions(): readonly HarnessToolDefinition[] {
  return [
    {
      description: TASK_CANCEL_DESCRIPTION,
      inputSchema: TASK_CANCEL_INPUT_SCHEMA,
      name: TASK_CANCEL_TOOL_NAME,
      outputSchema: TASK_VIEWS_OUTPUT_SCHEMA,
      runtimeAction: { kind: "task-control" },
    },
    {
      description: TASK_UPDATE_DESCRIPTION,
      inputSchema: TASK_UPDATE_INPUT_SCHEMA,
      name: TASK_UPDATE_TOOL_NAME,
      runtimeAction: { kind: "task-control" },
    },
  ];
}

/**
 * Authored tools with the same name shadow these framework definitions,
 * and `disableTool(name)` removes individual controls. advertised-tools
 * uses caller/session shape to expose only `task_update` to task children.
 */
