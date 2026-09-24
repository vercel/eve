import type { FlexibleSchema } from "ai";

import type { Approval } from "#approval/definition.js";
import type { InternalToolLabelDefinition, ToolExecuteOptions } from "#tools/definition.js";
import type { JsonValue } from "#shared/json.js";
import type { PreparedToolBehavior } from "#tools/behavior.js";
import type { TaskTimeout } from "#shared/task-timeout.js";
import type { WorkflowToolDetach } from "#tools/workflow-definition.js";

/**
 * Unified harness-owned tool definition.
 */
export interface HarnessToolDefinition {
  readonly availableInSubagents?: boolean;
  readonly label?: InternalToolLabelDefinition;
  readonly approvalKey?: (toolInput: Readonly<Record<string, unknown>>) => string;
  readonly behavior?: PreparedToolBehavior;
  readonly description: string;
  /** Workflow tools only: `true` returns a receipt instead of waiting for the run. */
  readonly detach?: WorkflowToolDetach;
  /** Workflow tools only: the time limit for each call. */
  readonly timeout?: TaskTimeout;
  readonly execute?: (input: any, options: ToolExecuteOptions) => any;
  /** Optional JSON input substituted when this tool starts its workflow body. */
  readonly executeInput?: (input: unknown) => JsonValue;
  readonly frameworkAction?: "load-skill";
  readonly inputSchema: FlexibleSchema;
  readonly name: string;
  /** Selected agent definition's runtime graph ID; absent for authored workflow tools. */
  readonly nodeId?: string;
  readonly approval?: Approval;
  readonly outputSchema?: FlexibleSchema;
  /**
   * Advertise this tool only to the root session, hiding it from subagent
   * sessions. Set on the injected `agent` self-delegation tool so children
   * cannot delegate recursively. Absent means visible everywhere.
   */
  readonly rootOnly?: boolean;
  readonly toModelOutput?: (output: unknown) => unknown;
  /** Present when this tool starts an associated durable workflow. */
  readonly workflowId?: string;
}
