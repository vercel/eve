import { z } from "#compiled/zod/index.js";

import { requestTurnSleep } from "#harness/turn-sleep.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

/**
 * Framework task tools for `experimental.tasks`.
 *
 * With the flag on, subagent calls return a task receipt instead of
 * blocking the parent turn; these tools are the model's controls over
 * that delegated work. `task_peek` and `task_cancel` are
 * execute-less runtime actions — they need durable session state and
 * world access, so the runtime-action dispatch step executes them.
 * `task_sleep` only records a durable pause and executes in-loop.
 */

export const TASK_PEEK_TOOL_NAME = "task_peek";
export const TASK_CANCEL_TOOL_NAME = "task_cancel";
export const TASK_SEND_TOOL_NAME = "task_send";
export const TASK_SLEEP_TOOL_NAME = "task_sleep";

/** Every model-visible task tool name, for gating and dispatch matching. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  TASK_PEEK_TOOL_NAME,
  TASK_CANCEL_TOOL_NAME,
  TASK_SEND_TOOL_NAME,
  TASK_SLEEP_TOOL_NAME,
]);

/** Task-control tools executed by the runtime-action dispatch step. */
export const TASK_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  TASK_PEEK_TOOL_NAME,
  TASK_CANCEL_TOOL_NAME,
  TASK_SEND_TOOL_NAME,
]);

const TASK_IDS_SCHEMA = z
  .array(z.string().min(1))
  .min(1)
  .describe("Task ids from earlier subagent task receipts.");

export const TASK_PEEK_INPUT_SCHEMA = z.strictObject({ taskIds: TASK_IDS_SCHEMA });
export const TASK_CANCEL_INPUT_SCHEMA = z.strictObject({ taskIds: TASK_IDS_SCHEMA });

export const TASK_SEND_INPUT_SCHEMA = z.strictObject({
  message: z
    .string()
    .describe(
      "Follow-up message for a finished task's agent; starts a new task in the same conversation.",
    ),
  taskId: z.string().min(1).describe("Task id from an earlier task receipt."),
});

const MAX_SLEEP_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

export const TASK_SLEEP_INPUT_SCHEMA = z.strictObject({
  seconds: z.number().positive().max(MAX_SLEEP_SECONDS).describe("How long to wait, in seconds."),
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

export const TASK_SLEEP_OUTPUT_SCHEMA = z.strictObject({
  waitedSeconds: z.number().positive(),
});

const TASK_PEEK_DESCRIPTION =
  "Read the current state of one or more background tasks without waiting. " +
  "Returns each task's status and, for finished tasks, its output. Does not wake or change the task.";

const TASK_CANCEL_DESCRIPTION =
  "Request cooperative cancellation of one or more background tasks. " +
  "Cancellation is final: a task that finishes after you cancel it stays cancelled. Cancelling an already-finished task changes nothing.";

const TASK_SEND_DESCRIPTION =
  "Send a follow-up message to a finished background task's agent. " +
  "This starts a new task in the same conversation and returns its receipt. " +
  "Human input for an input_required task is routed directly through the parent channel. " +
  "A task that is still working cannot receive sends.";

const TASK_SLEEP_DESCRIPTION =
  "Pause durably before continuing, for paced background-task checks. " +
  "Does not read or change any task; follow it with task_peek.";

/**
 * Builds the harness definitions injected when the root agent enables
 * `experimental.tasks`. Follows the implicit `agent` tool pattern:
 * inline definitions, no registry entry, session-shape hiding in
 * advertised-tools, and re-validation at dispatch.
 */
export function createTaskToolHarnessDefinitions(): readonly HarnessToolDefinition[] {
  return [
    {
      description: TASK_PEEK_DESCRIPTION,
      inputSchema: TASK_PEEK_INPUT_SCHEMA,
      name: TASK_PEEK_TOOL_NAME,
      outputSchema: TASK_VIEWS_OUTPUT_SCHEMA,
      runtimeAction: { kind: "task-control" },
    },
    {
      description: TASK_CANCEL_DESCRIPTION,
      inputSchema: TASK_CANCEL_INPUT_SCHEMA,
      name: TASK_CANCEL_TOOL_NAME,
      outputSchema: TASK_VIEWS_OUTPUT_SCHEMA,
      runtimeAction: { kind: "task-control" },
    },
    {
      description: TASK_SEND_DESCRIPTION,
      inputSchema: TASK_SEND_INPUT_SCHEMA,
      name: TASK_SEND_TOOL_NAME,
      runtimeAction: { kind: "task-control" },
    },
    {
      description: TASK_SLEEP_DESCRIPTION,
      execute: async (input: { readonly seconds: number }) => {
        requestTurnSleep(Math.ceil(input.seconds * 1_000));
        return { waitedSeconds: input.seconds };
      },
      inputSchema: TASK_SLEEP_INPUT_SCHEMA,
      name: TASK_SLEEP_TOOL_NAME,
      outputSchema: TASK_SLEEP_OUTPUT_SCHEMA,
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
 * config, so advertised-tools additionally hides the tools from any
 * child-shaped session.
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
  createResolvedTaskToolStub({ description: TASK_PEEK_DESCRIPTION, name: TASK_PEEK_TOOL_NAME }),
  createResolvedTaskToolStub({ description: TASK_CANCEL_DESCRIPTION, name: TASK_CANCEL_TOOL_NAME }),
  createResolvedTaskToolStub({ description: TASK_SEND_DESCRIPTION, name: TASK_SEND_TOOL_NAME }),
  createResolvedTaskToolStub({ description: TASK_SLEEP_DESCRIPTION, name: TASK_SLEEP_TOOL_NAME }),
];
