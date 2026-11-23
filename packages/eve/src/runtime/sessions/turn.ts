import type { Node } from "#shared/node.js";
import type { SourceRef } from "#shared/source-ref.js";
import type { InternalToolDefinition } from "#tools/definition.js";
import type { WorkflowProgramOptions } from "#tools/workflow-program-input.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";
import type { PreparedToolBehavior } from "#tools/behavior.js";

export type PreparedRuntimeAuthoredTool = Readonly<
  InternalToolDefinition &
    SourceRef & {
      behavior?: PreparedToolBehavior;
      kind: "authored-tool";
      owner: AgentSourceOwner;
      rootOnly?: boolean;
      workflowProgram?: WorkflowProgramOptions;
    }
>;

type PreparedRuntimeDelegationToolBase<TKind extends "remote" | "subagent"> = Readonly<
  InternalToolDefinition &
    SourceRef &
    Node & {
      behavior: PreparedToolBehavior;
      kind: TKind;
      rootOnly?: boolean;
    }
>;

type PreparedRuntimeSubagentTool = PreparedRuntimeDelegationToolBase<"subagent">;

type PreparedRuntimeRemoteAgentTool = PreparedRuntimeDelegationToolBase<"remote">;

export type PreparedRuntimeDelegationTool =
  | PreparedRuntimeRemoteAgentTool
  | PreparedRuntimeSubagentTool;

export type PreparedRuntimeTool = PreparedRuntimeAuthoredTool | PreparedRuntimeDelegationTool;
