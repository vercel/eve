import type { CompiledToolDefinition } from "#compiler/manifest.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";

export interface CompiledToolBindings {
  readonly bindings: Readonly<Record<string, { readonly owner: AgentSourceOwner }>>;
}

export function isInvocableCompiledTool(
  manifest: CompiledToolBindings,
  tool: Pick<CompiledToolDefinition, "behavior" | "hasExecute" | "name" | "sourceId">,
): boolean {
  const owner = compiledToolOwner(manifest, tool);
  return tool.hasExecute && tool.behavior?.handling === undefined && owner.kind !== "framework";
}

export function compiledToolOwner(
  manifest: CompiledToolBindings,
  tool: Pick<CompiledToolDefinition, "name" | "sourceId">,
): AgentSourceOwner {
  const binding = Object.hasOwn(manifest.bindings, tool.sourceId)
    ? manifest.bindings[tool.sourceId]
    : undefined;
  if (binding === undefined) {
    throw new Error(`Compiled tool "${tool.name}" has no source binding.`);
  }
  return binding.owner;
}
