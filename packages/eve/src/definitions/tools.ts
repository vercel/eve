import { assertNotConnectionOwned } from "#connections/ownership.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { TOOL_SLUG_PATTERN, TOOL_SLUG_RULE } from "#discover/grammar.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { compiledBundleOf } from "#runtime/sessions/runtime-context-keys.js";
import { workflowIdForHandling } from "#runtime/subagents/workflow-reference.js";
import type { ResolvedDynamicDefinition } from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";
import type { InternalToolDefinition, ToolDefinition } from "#tools/definition.js";
import { isBrandedToolEntry, type DynamicToolEntry } from "#tools/dynamic.js";
import { isFrameworkTool } from "#tools/provided/framework-tool.js";
import {
  serializeInputSchema,
  serializeOutputSchema,
  toInputSchema,
  toOutputSchema,
  type ToolSchemaSource,
} from "#tools/schema.js";
import { isWorkflowToolDefinition } from "#tools/workflow-definition.js";
import { namedEntries, type EntryKind } from "./named.js";
import { entryVersions, slotsOf } from "#definitions/state.js";
import { sessionConnectionNames } from "./connections.js";
import {
  authoredEvaluate,
  type Definition,
  type InternalContext,
  type Kept,
  type ToolEntry,
} from "./definition.js";

/**
 * The agent's `defineTool()` files: the same tools in every session, so they keep nothing. The step
 * holds them, as it runs them outside a turn too; each joins the call like any other tool.
 */
export const staticTools: Definition = {
  contribute: ({ step }) => ({
    tools: () => ({ entries: toolEntries([...(step?.agentTools.values() ?? [])], "eve.tools") }),
  }),
  id: "eve.tools",
  label: "the agent's tools",
};

/**
 * A `defineDynamic()` in `agent/tools/`: one tool named after the file, or a map of them. It keeps
 * what the model is offered; the tools themselves are code. Its tools take their names from the
 * agent's own.
 */
export function toolDefinition(resolver: ResolvedDynamicDefinition<"tool">): Definition {
  return toolsDefinition(resolver, authoredEvaluate(resolver.evaluate));
}

/**
 * Tools `evaluate` makes, as the tool file `source` names would: a `defineDynamic()` tool file's,
 * or an eve feature's, which offers its tools under the file it would take, such as a memory
 * slot's. Their versions are kept under that file's ID.
 */
export function toolsDefinition(
  source: ToolSource,
  evaluate: (ctx: InternalContext) => unknown,
): Definition {
  const id = `tool:${source.extensionNamespace ?? ""}:${source.slug}`;
  return {
    contribute: (ctx) => ({
      tools: async () => {
        const kept = await ctx.keep(async (evaluation) =>
          contributeTools(source, await evaluate(evaluation), evaluation.ctx),
        );
        const declarations = Array.isArray(kept?.value) ? kept.value : [];
        const versionOf = entryVersions(ctx.container, id);
        const built = (kept?.live as readonly HarnessToolDefinition[] | undefined) ?? [];
        return {
          entries: new Map(
            built.map((definition, index): [string, ToolEntry] => [
              definition.name,
              {
                definition: { ...definition, version: versionOf(declarations[index] ?? null) },
                source: id,
              },
            ]),
          ),
        };
      },
    }),
    id,
    label: source.logicalPath,
  };
}

/** The names of the dynamic tools the session keeps, live or not. */
export function dynamicToolNames(ctx: Pick<ContextReader, "get">): readonly string[] {
  return slotsOf(ctx, "tool").flatMap(({ slot }) =>
    Array.isArray(slot.value) ? slot.value.map((tool) => (tool as { name: string }).name) : [],
  );
}

export function toolEntries(
  definitions: readonly HarnessToolDefinition[],
  source?: string,
): Map<string, ToolEntry> {
  return new Map(
    definitions.map((definition) => [
      definition.name,
      source === undefined ? { definition } : { definition, source },
    ]),
  );
}

/** Where dynamic tools come from: a file, by its slug, in an extension's namespace or none. */
export interface ToolSource {
  readonly extensionNamespace?: string;
  readonly logicalPath: string;
  readonly slug: string;
}

/** The tools `result` defines, checked and named as `source`'s, with their declarations. */
export function contributeTools(source: ToolSource, result: unknown, ctx: ContextContainer): Kept {
  const tools = namedTools(source, result).map(({ entry, name }) => {
    assertToolNameAvailable(ctx, source, name);
    return liveTool(name, entry);
  });
  if (tools.length === 0) return { value: null };
  return { live: tools, value: tools.map(declaration) };
}

const TOOLS: EntryKind = {
  is: isBrandedToolEntry,
  made: "defineTool()",
  noun: "tool",
  pattern: TOOL_SLUG_PATTERN,
  qualifiedPattern: TOOL_SLUG_PATTERN,
  rule: TOOL_SLUG_RULE,
};

function namedTools(source: ToolSource, value: unknown) {
  const entries = namedEntries(source, value, TOOLS);
  for (const { entry } of entries) {
    if (isWorkflowToolDefinition(entry)) {
      throw new Error(
        `The defineDynamic() in "${source.logicalPath}" cannot return defineWorkflowTool(). Workflow tools must be static tools; use defineTool() for dynamic entries.`,
      );
    }
  }
  return entries as readonly { readonly name: string; readonly entry: DynamicToolEntry }[];
}

/**
 * The agent's workflow tools and agents run after the model step, so a dynamic tool, which runs in
 * it, can't take their names. Nor can a connection's.
 */
function assertToolNameAvailable(ctx: ContextContainer, resolver: ToolSource, name: string): void {
  assertNotConnectionOwned({
    connectionNames: sessionConnectionNames(ctx),
    name,
    remedy: "Rename the map key.",
    subject: "Dynamic tool",
  });
  const bundle = compiledBundleOf(ctx);
  if (bundle === undefined) return;
  const { subagentRegistry, toolRegistry } = bundle;
  const workflowNames = new Set([
    ...[...toolRegistry.toolsByName.values()]
      .filter(({ prepared }) => workflowIdForHandling(prepared.behavior?.handling) !== undefined)
      .map(({ prepared }) => prepared.name),
    ...subagentRegistry.preparedTools.map((tool) => tool.name),
    ...subagentRegistry.dynamicResolvers.map((dynamic) => dynamic.name),
  ]);
  if (workflowNames.has(name)) {
    throw new Error(
      `Dynamic tool "${name}" from "${resolver.logicalPath}" collides with the workflow tool or agent "${name}". Rename the map key.`,
    );
  }
}

function liveTool(name: string, authored: DynamicToolEntry): HarnessToolDefinition {
  const entry = authored as ToolDefinition<unknown, unknown>;
  const definition = entry as ToolDefinition<unknown, unknown> & Partial<InternalToolDefinition>;
  return {
    approval: entry.approval,
    availableInSubagents: entry.availableInSubagents,
    deferred: entry.deferred,
    description: entry.description,
    endsTurn: entry.endsTurn,
    execute: createToolExecuteWithAuth({
      execute: (input, context) => entry.execute(input as never, context),
      scope: name,
    }),
    frameworkTool: isFrameworkTool(entry) || undefined,
    inputSchema: toInputSchema(entry.inputSchema as ToolSchemaSource),
    label: definition.label as HarnessToolDefinition["label"],
    name,
    outputSchema:
      entry.outputSchema === undefined
        ? undefined
        : toOutputSchema(entry.outputSchema as ToolSchemaSource),
    toModelOutput: entry.toModelOutput as HarnessToolDefinition["toModelOutput"],
  };
}

/** What a tool's slot records: what the model is offered, without the code. */
function declaration(tool: HarnessToolDefinition): JsonObject {
  return {
    description: tool.description,
    inputSchema: serializeInputSchema(tool.inputSchema as ToolSchemaSource),
    name: tool.name,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: serializeOutputSchema(tool.outputSchema as ToolSchemaSource) }),
    ...(tool.deferred === true && { deferred: true }),
    ...(tool.endsTurn === true && { endsTurn: true }),
    ...(tool.availableInSubagents === false && { availableInSubagents: false }),
  };
}
