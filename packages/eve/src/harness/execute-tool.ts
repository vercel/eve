import type { FlexibleSchema } from "ai";

import type { Approval } from "#approval/definition.js";
import type {
  InternalToolDefinition,
  InternalToolLabelDefinition,
  ToolExecuteOptions,
  ToolModelOutputContext,
} from "#tools/definition.js";
import type { JsonValue } from "#shared/json.js";
import type { PreparedToolBehavior } from "#tools/behavior.js";
import type { WorkflowProgramOptions } from "#tools/workflow-program-input.js";

export interface HarnessToolDefinition {
  readonly agentApprovalIncluded?: boolean;
  readonly availableInSubagents?: boolean;
  readonly label?: InternalToolLabelDefinition | false;
  readonly behavior?: PreparedToolBehavior;
  readonly deferred?: boolean;
  readonly description: string;
  readonly endsTurn?: InternalToolDefinition["endsTurn"];
  readonly execute?: (input: any, options: ToolExecuteOptions) => any;
  readonly executeInput?: (input: unknown) => JsonValue;
  readonly frameworkTool?: boolean;
  readonly frameworkAction?: "task-cancel" | "task-wait";
  readonly interactionOnly?: boolean;
  readonly inputSchema: FlexibleSchema;
  readonly name: string;
  readonly approval?: Approval;
  readonly outputSchema?: FlexibleSchema;
  readonly rootOnly?: boolean;
  readonly toModelOutput?: (output: unknown, ctx: ToolModelOutputContext) => unknown;
  readonly version?: string;
  readonly workflowId?: string;
  readonly workflowProgram?: WorkflowProgramOptions;
}
