import type { FlexibleSchema } from "ai";

import type { Approval } from "#approval/definition.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { TaskExec } from "#tools/task.js";
import type { PreparedToolBehavior } from "#tools/behavior.js";

/**
 * Unified harness-owned tool definition.
 */
export interface HarnessToolDefinition {
  readonly approvalKey?: (toolInput: Readonly<Record<string, unknown>>) => string;
  readonly behavior?: PreparedToolBehavior;
  readonly description: string;
  readonly execute?: (input: any, options: ToolExecuteOptions, task?: TaskExec) => any;
  readonly execution?: "background";
  readonly inputSchema: FlexibleSchema;
  readonly name: string;
  readonly approval?: Approval;
  readonly outputSchema?: FlexibleSchema;
  readonly toModelOutput?: (output: unknown) => unknown;
}
