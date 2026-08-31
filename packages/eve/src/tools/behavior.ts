import type { WebSearchProvider } from "#shared/web-search.js";

/** Session facts that can hide a selected tool without changing source composition. */
export type ToolAvailabilityCondition =
  | "delegated-task-child"
  | "requires-request-input"
  | "root-session";

/** Native behavior declared by a selected compiled tool. */
export type CompiledToolHandling =
  | { readonly kind: "dispatch"; readonly action: "self-agent" | "task-cancel" | "task-update" }
  | { readonly kind: "provider-tool"; readonly provider: WebSearchProvider }
  | { readonly kind: "request-input"; readonly request: "question" };

/** Closed, serializable behavior carried by one selected compiled tool. */
export interface CompiledToolBehavior {
  readonly availability: readonly ToolAvailabilityCondition[];
  readonly handling?: CompiledToolHandling;
  readonly presentation?: "load-skill";
}

/** Concrete dispatch identity prepared before a tool reaches the harness. */
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
  | { readonly kind: "task-cancel" }
  | { readonly kind: "task-update" };

/** Runtime-prepared handling consumed by the harness and execution boundary. */
export type PreparedToolHandling =
  | { readonly kind: "dispatch"; readonly target: PreparedDispatchTarget }
  | Extract<CompiledToolHandling, { readonly kind: "provider-tool" | "request-input" }>;

/** Runtime-prepared behavior carried by one harness-visible tool. */
export interface PreparedToolBehavior {
  readonly availability: readonly ToolAvailabilityCondition[];
  readonly handling?: PreparedToolHandling;
  readonly presentation?: CompiledToolBehavior["presentation"];
}

// Framework definitions and the compiler may come from different bundled copies.
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

/** Reads internal behavior from a framework-owned definition. */
export function readToolBehavior(value: unknown): CompiledToolBehavior | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Partial<ToolBehaviorCarrier>)[TOOL_BEHAVIOR];
}
