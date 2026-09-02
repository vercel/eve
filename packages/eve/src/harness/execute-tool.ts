import type { FlexibleSchema } from "ai";

import type { Approval } from "#approval/definition.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { TaskExec } from "#tools/task.js";
import type { JsonValue } from "#shared/json.js";
import type { PreparedToolBehavior } from "#tools/behavior.js";

/**
 * Runtime-owned action metadata attached to one harness-visible tool.
 *
 * `task-control` marks the parent-side background task tools
 * (`task_cancel`, `task_update`): they carry no child
 * address of their own — the dispatch step resolves targets through the
 * session task index by tool name.
 */
export type HarnessRuntimeActionDefinition = { readonly kind: "task-control" };

/**
 * Unified harness-owned tool definition.
 */
export interface HarnessToolDefinition {
  readonly approvalKey?: (toolInput: Readonly<Record<string, unknown>>) => string;
  readonly behavior?: PreparedToolBehavior;
  readonly description: string;
  readonly execute?: (input: any, options: ToolExecuteOptions, task?: TaskExec) => any;
  /** Optional JSON input substituted when this tool starts its workflow body. */
  readonly executeInput?: (input: unknown) => JsonValue;
  readonly execution?: "background";
  readonly frameworkAction?: "load-skill";
  readonly inputSchema: FlexibleSchema;
  readonly name: string;
  /** Runtime graph node for a framework subagent workflow body. */
  readonly nodeId?: string;
  readonly approval?: Approval;
  readonly outputSchema?: FlexibleSchema;
  readonly resultKind?: "subagent" | "tool";
  /**
   * Advertise this tool only to the root session, hiding it from subagent
   * sessions. Set on the injected `agent` self-delegation tool so children
   * cannot delegate recursively. Absent means visible everywhere.
   */
  readonly rootOnly?: boolean;
  readonly runtimeAction?: HarnessRuntimeActionDefinition;
  readonly toModelOutput?: (output: unknown) => unknown;
  /** Present when this tool starts an associated durable workflow. */
  readonly workflowId?: string;
}
