import type { Node } from "#shared/node.js";
import type { SourceRef } from "#shared/source-ref.js";
import type { InternalToolDefinition } from "#tools/definition.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";

/** Serializable workflow-task metadata prepared for the harness. */
export interface PreparedRuntimeWorkflowTask {
  readonly resultKind?: "subagent" | "tool";
  readonly nodeId?: string;
  readonly workflowId: string;
}

/**
 * Serializable authored tool descriptor prepared by the runtime for one
 * harness turn.
 */
export type PreparedRuntimeAuthoredTool = Readonly<
  InternalToolDefinition &
    SourceRef & {
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
