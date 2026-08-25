import type { Node } from "#shared/node.js";
import type { SourceRef } from "#shared/source-ref.js";
import type { InternalToolDefinition } from "#tools/definition.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";

/**
 * Serializable authored tool descriptor prepared by the runtime for one
 * harness turn.
 */
export type PreparedRuntimeAuthoredTool = Readonly<
  InternalToolDefinition &
    SourceRef & {
      kind: "authored-tool";
      owner: AgentSourceOwner;
    }
>;

type PreparedRuntimeDelegationToolBase<TKind extends "remote" | "subagent"> = Readonly<
  Omit<InternalToolDefinition, "execution"> &
    SourceRef &
    Node & {
      execution?: "blocking" | "background";
      kind: TKind;
      targetKind?: "local" | "remote";
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
