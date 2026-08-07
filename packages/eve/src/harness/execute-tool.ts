import type { FlexibleSchema } from "ai";

import type { Approval } from "#public/definitions/approval.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/**
 * Runtime-owned action metadata attached to one harness-visible tool.
 *
 * These tools are surfaced to the model without a local `execute` function.
 * The harness records the tool call and the runtime executes it later.
 *
 * `task-control` marks the `experimental.tasks` parent tools
 * (`task_peek`, `task_cancel`): they carry no child
 * address of their own — the dispatch step resolves targets through the
 * session task index by tool name.
 */
export type HarnessRuntimeActionDefinition =
  | {
      readonly kind: "remote-agent-call" | "subagent-call";
      readonly nodeId: string;
      readonly remoteAgentName?: string;
      readonly subagentName: string;
    }
  | { readonly kind: "task-control" };

/**
 * Unified harness-owned tool definition.
 */
export interface HarnessToolDefinition {
  readonly approvalKey?: (toolInput: Readonly<Record<string, unknown>>) => string;
  readonly description: string;
  readonly execute?: (input: any, options: ToolExecuteOptions) => any;
  readonly inputSchema: FlexibleSchema;
  readonly name: string;
  readonly approval?: Approval;
  readonly outputSchema?: FlexibleSchema;
  readonly runtimeAction?: HarnessRuntimeActionDefinition;
  readonly toModelOutput?: (output: unknown) => unknown;
}
