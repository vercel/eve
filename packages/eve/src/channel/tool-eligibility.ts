import type { CompiledToolDefinition } from "#compiler/manifest.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";

/** The part of a compiled manifest that records who contributed each source. */
export interface CompiledToolBindings {
  readonly bindings: Readonly<Record<string, { readonly owner: AgentSourceOwner }>>;
}

/**
 * The one rule for whether a compiled tool can run outside a turn. `describe()`
 * lists only tools for which it holds, and `invokeTool` refuses the rest.
 *
 * A tool is invocable when all three hold:
 *
 * 1. `hasExecute`: the tool has an `execute` function.
 * 2. No `behavior.handling`. Handled tools (`dispatch`, `workflow-tool`,
 *    `provider-tool`, and any handling kind added later) are run by the
 *    harness or a provider, not by calling `execute`.
 * 3. The owner of its source binding is not `"framework"`. This is a
 *    conservative phase-1 policy, stricter than the mechanical predicate in
 *    the research plan (`hasExecute` minus handled tools and framework
 *    actions). It is not a claim that every framework tool needs a turn: some,
 *    such as `agent`, depend on the turn's harness or session, while others, such as `web_fetch`, could run without one. They
 *    are all withheld so that phase 1 publishes only tools the application or
 *    an extension authored; exposing individual framework tools is a later,
 *    explicit decision. An application or extension tool that overrides a
 *    framework tool name is owned by the application or extension and stays
 *    invocable.
 *
 * There is no background-tool marker in the compiled registry. A background
 * tool is excluded only when one of these rules already covers it.
 *
 * Throws when the tool has no source binding, which a valid manifest never
 * produces.
 */
export function isInvocableCompiledTool(
  manifest: CompiledToolBindings,
  tool: Pick<CompiledToolDefinition, "behavior" | "hasExecute" | "name" | "sourceId">,
): boolean {
  const owner = compiledToolOwner(manifest, tool);
  return tool.hasExecute && tool.behavior?.handling === undefined && owner.kind !== "framework";
}

/** Owner of the source binding that contributed a compiled tool. */
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
