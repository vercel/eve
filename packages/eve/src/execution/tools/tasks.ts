import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  TASK_CANCEL_INPUT_SCHEMA,
  TASK_CANCEL_TOOL_NAME,
  TASK_UPDATE_INPUT_SCHEMA,
  TASK_UPDATE_TOOL_NAME,
  TASK_VIEWS_OUTPUT_SCHEMA,
} from "#shared/task-tool.js";

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
 * Builds the harness definitions injected when the root agent enables
 * `experimental.tasks`. Follows the implicit `agent` tool pattern:
 * inline definitions, no registry entry, session-shape hiding in
 * advertised-tools, and re-validation at dispatch.
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
 * Mirrors `isImplicitAgentToolAvailable`: the compile step already
 * rejects `experimental.tasks` on subagents, authored tools with the
 * same name shadow the framework tool, and `disableTool(name)` removes
 * individual tools. Root-node self-delegated children share this node's
 * config, so advertised-tools uses caller/session shape to expose only
 * `task_update` to delegated task children.
 */
