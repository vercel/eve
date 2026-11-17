import type { WebSearchSelection } from "#shared/web-search.js";
import type { WorkflowToolEntryPoint } from "#tools/workflow-entry-point.js";

/** Session facts that can hide a selected tool without changing source composition. */
export type ToolAvailabilityCondition = "root-session";

/** Native behavior declared by a selected compiled tool. */
export type CompiledToolHandling =
  | { readonly kind: "dispatch"; readonly action: "self-agent" }
  | ({ readonly kind: "provider-tool" } & WebSearchSelection)
  | {
      readonly kind: "workflow-tool";
      readonly entryPoint: WorkflowToolEntryPoint;
      readonly workflowId: string;
    };

/** Closed, serializable behavior carried by one selected compiled tool. */
export interface ToolExecutionShape {
  readonly suspend: "none" | "workflow";
}

export interface CompiledToolBehavior {
  readonly availability: readonly ToolAvailabilityCondition[];
  readonly handling?: CompiledToolHandling;
  readonly shape?: ToolExecutionShape;
}

export type PreparedDispatchTarget =
  | {
      readonly kind: "remote-agent-call";
      readonly nodeId: string;
      readonly remoteAgentName: string;
    }
  | {
      readonly kind: "self-agent-call";
      readonly nodeId: string;
      readonly subagentName: string;
    }
  | {
      readonly kind: "subagent-call";
      readonly nodeId: string;
      readonly subagentName: string;
    }
  | {
      readonly kind: "workflow-tool-call";
      readonly entryPoint: WorkflowToolEntryPoint;
      readonly workflowId: string;
    };

export type PreparedToolHandling =
  | { readonly kind: "dispatch"; readonly target: PreparedDispatchTarget }
  | Extract<CompiledToolHandling, { readonly kind: "provider-tool" }>;

export interface PreparedToolBehavior {
  readonly availability: readonly ToolAvailabilityCondition[];
  readonly handling?: PreparedToolHandling;
}

const TOOL_BEHAVIOR = Symbol.for("eve.tool-behavior");

type ToolBehaviorCarrier = {
  readonly [TOOL_BEHAVIOR]: CompiledToolBehavior;
};

/** Attaches internal behavior without adding a public string-keyed definition field. */
export function attachToolBehavior<TDefinition extends object>(
  definition: TDefinition,
  behavior: CompiledToolBehavior,
): TDefinition {
  Object.defineProperty(definition, TOOL_BEHAVIOR, {
    configurable: false,
    enumerable: false,
    value: behavior,
    writable: false,
  });
  return definition;
}

export function readToolBehavior(value: unknown): CompiledToolBehavior | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Partial<ToolBehaviorCarrier>)[TOOL_BEHAVIOR];
}
