import type { FlexibleSchema } from "ai";

import type { ToolApproval } from "#approval/definition.js";
import type { InternalToolLabelDefinition, ToolExecuteOptions } from "#tools/definition.js";
import type { JsonValue } from "#shared/json.js";
import type { PreparedToolBehavior } from "#tools/behavior.js";

/**
 * Runtime-owned action metadata attached to one harness-visible tool.
 *
 * `task-control` marks `task_cancel`: it carries no child address of its
 * own — the dispatch step resolves targets through the session task index.
 */
export type HarnessRuntimeActionDefinition = { readonly kind: "task-control" };

/**
 * Unified harness-owned tool definition.
 */
export interface HarnessToolDefinition {
  readonly availableInSubagents?: boolean;
  readonly label?: InternalToolLabelDefinition;
  readonly approvalKey?: (toolInput: Readonly<Record<string, unknown>>) => string;
  readonly behavior?: PreparedToolBehavior;
  readonly description: string;
  readonly execute?: (input: any, options: ToolExecuteOptions) => any;
  /** Optional JSON input substituted when this tool starts its workflow body. */
  readonly executeInput?: (input: unknown) => JsonValue;
  readonly execution?: "background";
  readonly frameworkAction?: "load-skill";
  readonly inputSchema: FlexibleSchema;
  readonly name: string;
  /** Selected agent definition's runtime graph ID; absent for authored workflow tools. */
  readonly nodeId?: string;
  readonly approval?: ToolApproval;
  readonly outputSchema?: FlexibleSchema;
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
