import type { Node } from "#shared/node.js";
import type { SourceRef } from "#shared/source-ref.js";
import type { InternalToolDefinition } from "#shared/tool-definition.js";

/**
 * Serializable authored tool descriptor prepared by the runtime for one
 * harness turn.
 */
export type PreparedRuntimeAuthoredTool = Readonly<
  InternalToolDefinition &
    SourceRef & {
      kind: "authored-tool";
    }
>;

type PreparedRuntimeDelegationToolBase<TKind extends "remote" | "subagent"> = Readonly<
  InternalToolDefinition &
    SourceRef &
    Node & {
      kind: TKind;
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
