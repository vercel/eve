import { z } from "#compiled/zod/index.js";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

/**
 * Framework task tools for `experimental.tasks`.
 *
 * With the flag on, subagent calls return a task receipt instead of
 * blocking the parent turn; these tools coordinate that delegated work.
 * `task_cancel` and `task_update` are execute-less runtime actions —
 * they need durable session state and world access, so the runtime-action
 * dispatch step executes them.
 */

export const TASK_CANCEL_TOOL_NAME = "task_cancel";
export const TASK_UPDATE_TOOL_NAME = "task_update";

/** Every model-visible task tool name, for gating and dispatch matching. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  TASK_CANCEL_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
]);

/** Task-control tools executed by the runtime-action dispatch step. */
export const TASK_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  TASK_CANCEL_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
]);

const TASK_IDS_SCHEMA = z
  .array(z.string().min(1))
  .min(1)
  .describe("Task ids from earlier subagent task receipts.");

export const TASK_CANCEL_INPUT_SCHEMA = z.strictObject({ taskIds: TASK_IDS_SCHEMA });

export const TASK_UPDATE_INPUT_SCHEMA = z.strictObject({
  message: z.string().min(1).describe("Brief description of what this task is currently doing."),
});

const TASK_VIEW_SCHEMA = z.object({
  inputRequests: z.array(z.unknown()).optional(),
  lastOutput: z
    .object({
      data: z.unknown(),
      type: z.enum(["result", "error"]),
    })
    .optional(),
  metadata: z.object({
    agentId: z.string(),
    kind: z.literal("subagent"),
    mode: z.enum(["local", "remote"]),
    name: z.string(),
  }),
  status: z.enum(["working", "input_required", "completed", "failed", "cancelled"]),
  taskId: z.string(),
});

export const TASK_VIEWS_OUTPUT_SCHEMA = z.object({
  tasks: z.array(TASK_VIEW_SCHEMA),
});

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
export function isTaskToolAvailable(input: {
  readonly disabledFrameworkTools: readonly string[];
  readonly hasAuthoredTool: boolean;
  readonly tasksEnabled: boolean;
  readonly toolName: string;
}): boolean {
  return (
    input.tasksEnabled &&
    !input.disabledFrameworkTools.includes(input.toolName) &&
    !input.hasAuthoredTool
  );
}

function createResolvedTaskToolStub(input: {
  readonly description: string;
  readonly name: string;
}): ResolvedToolDefinition {
  return {
    description: input.description,
    inputSchema: null,
    logicalPath: `eve:framework/${input.name}`,
    name: input.name,
    sourceId: `eve:${input.name}-tool`,
    sourceKind: "module",
  };
}

/**
 * Registry-shaped metadata for the task tools. Not registered in the
 * tool registry (the harness injects the real definitions per node);
 * these entries exist so `disableTool(name)` validates the names.
 */
export const TASK_TOOL_DEFINITIONS: readonly ResolvedToolDefinition[] = [
  createResolvedTaskToolStub({ description: TASK_CANCEL_DESCRIPTION, name: TASK_CANCEL_TOOL_NAME }),
  createResolvedTaskToolStub({ description: TASK_UPDATE_DESCRIPTION, name: TASK_UPDATE_TOOL_NAME }),
];
