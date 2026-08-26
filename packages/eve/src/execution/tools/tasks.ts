import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  TASK_CANCEL_INPUT_SCHEMA,
  TASK_CANCEL_TOOL_NAME,
  TASK_UPDATE_INPUT_SCHEMA,
  TASK_UPDATE_TOOL_NAME,
  TASK_VIEWS_OUTPUT_SCHEMA,
} from "#tools/framework/task-contract.js";

/**
 * Framework task tools for `experimental.tasks`.
 *
 * With the flag on, subagent calls return a task receipt instead of
 * blocking the parent turn; these tools coordinate that delegated work.
 * `task_cancel` and `task_update` are execute-less runtime actions —
 * they need durable session state and world access, so the runtime-action
 * dispatch step executes them.
 */

const TASK_CANCEL_DESCRIPTION =
  "Request cooperative cancellation of one or more background tasks. " +
  "Cancellation is final: a task that finishes after you cancel it stays cancelled. Cancelling an already-finished task changes nothing.";

const TASK_UPDATE_DESCRIPTION =
  "Briefly tell the parent agent what this background task is currently doing. " +
  "Report activity, not preliminary findings or results.";

/**
 * Builds the harness definitions injected into each runtime node when the root
 * enables `experimental.tasks`. Definitions are prepared from framework
 * defaults, lowered here, filtered per session in advertised-tools, and
 * re-validated at dispatch.
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
 * Whether one node's sessions receive the task tools.
 *
 * The root capability is projected onto every runtime node. Authored tools with
 * the same name shadow framework defaults, and `disableTool(name)` removes an
 * individual control. advertised-tools exposes `task_update` only to task-owned
 * sessions and keeps `task_cancel` available to any task-enabled session so a
 * declared child can cancel nested tasks it owns.
 */
