import type { FlexibleSchema } from "ai";

import type { Approval } from "#approval/definition.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { TaskExec } from "#tools/task.js";

/**
 * Runtime-owned action metadata attached to one harness-visible tool.
 *
 * These tools are surfaced to the model without a local `execute` function.
 * The harness records the tool call and the runtime executes it later.
 *
 * `task-control` marks the `experimental.tasks` parent tools
 * (`task_cancel`, `task_update`): they carry no child
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
  readonly execute?: (input: any, options: ToolExecuteOptions, task?: TaskExec) => any;
  readonly execution?: "background";
  readonly frameworkAction?: "load-skill";
  readonly inputSchema: FlexibleSchema;
  readonly name: string;
  readonly approval?: Approval;
  readonly outputSchema?: FlexibleSchema;
  /**
   * Advertise this tool only to the root session, hiding it from subagent
   * sessions. Set on the injected `agent` self-delegation tool so children
   * cannot delegate recursively. Absent means visible everywhere.
   */
  readonly rootOnly?: boolean;
  readonly runtimeAction?: HarnessRuntimeActionDefinition;
  /** Internal target kind used to register mixed-mode fanout before dispatch. */
  readonly subagentKind?: "local" | "remote";
  readonly toModelOutput?: (output: unknown) => unknown;
  readonly workflowCallable?: boolean;
}
