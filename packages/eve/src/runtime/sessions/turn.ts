import type { Node } from "#shared/node.js";
import type { SourceRef } from "#shared/source-ref.js";
import type { InternalToolDefinition } from "#tools/definition.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";
import type { PreparedToolBehavior } from "#tools/behavior.js";

/** Grouped durable workflow metadata for one prepared harness tool. */
export interface PreparedRuntimeWorkflowTask {
  /**
   * Runtime graph ID of the agent definition this tool delegates to, including
   * the root agent for the framework `agent` tool. Used for receipts and handle
   * reservations; `agentId` identifies the resulting agent instance.
   * Absent for authored workflow tools, even if their body calls `ctx.agent()`.
   */
  readonly nodeId?: string;
  /** Registered workflow definition to execute. */
  readonly workflowId: string;
}
/**
 * Serializable authored tool descriptor prepared by the runtime for one
 * harness turn.
 */
export type PreparedRuntimeAuthoredTool = Readonly<
  InternalToolDefinition &
    SourceRef & {
      behavior?: PreparedToolBehavior;
      kind: "authored-tool";
      owner: AgentSourceOwner;
      rootOnly?: boolean;
      task?: PreparedRuntimeWorkflowTask;
    }
>;

type PreparedRuntimeDelegationToolBase<TKind extends "remote" | "subagent"> = Readonly<
  Omit<InternalToolDefinition, "execution"> &
    SourceRef &
    Node & {
      behavior: PreparedToolBehavior;
      execution: "background";
      kind: TKind;
      rootOnly?: boolean;
      task: PreparedRuntimeWorkflowTask;
    }
>;

/**
 * Serializable local subagent descriptor prepared by the runtime for one
 * harness turn.
 */
type PreparedRuntimeSubagentTool = PreparedRuntimeDelegationToolBase<"subagent">;

/**
 * Serializable remote subagent descriptor prepared by the runtime for one
 * harness turn.
 */
type PreparedRuntimeRemoteAgentTool = PreparedRuntimeDelegationToolBase<"remote">;

/**
 * Serializable delegation descriptor prepared by the runtime for one harness
 * turn.
 */
export type PreparedRuntimeDelegationTool =
  | PreparedRuntimeRemoteAgentTool
  | PreparedRuntimeSubagentTool;

/**
 * Serializable model-visible runtime tool prepared for one harness turn.
 */
export type PreparedRuntimeTool = PreparedRuntimeAuthoredTool | PreparedRuntimeDelegationTool;
