import { assertNotConnectionOwned } from "#connections/ownership.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { TOOL_SLUG_PATTERN, TOOL_SLUG_RULE } from "#discover/grammar.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { createWorkflowToolHarnessDefinition } from "#execution/tools/workflow/harness-definition.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { assertNoOwnTaskIdInput } from "#internal/authored-definition/schema-backed.js";
import { readWorkflowFunctionId } from "#internal/workflow/reference.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
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
import {
  isWorkflowToolDefinition,
  readWorkflowToolEntryPoints,
} from "#tools/workflow-definition.js";
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
  const tools = namedEntries(source, result, TOOLS).map(({ entry, name }) => {
    assertToolNameAvailable(ctx, source, name);
    return liveTool(source, name, entry as DynamicToolEntry);
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

/**
 * The agent's workflow tools and agents are dispatched by name after the model step, so a dynamic
 * tool can't take their names. Nor can a connection's.
 */
function assertToolNameAvailable(ctx: ContextContainer, resolver: ToolSource, name: string): void {
  assertNotConnectionOwned({
    connectionNames: sessionConnectionNames(ctx),
    name,
    remedy: "Rename the map key.",
    subject: "Dynamic tool",
  });
  const bundle = ctx.get(BundleKey);
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

function liveTool(
  source: ToolSource,
  name: string,
  authored: DynamicToolEntry,
): HarnessToolDefinition {
  const entry = authored as ToolDefinition<unknown, unknown>;
  const definition = entry as ToolDefinition<unknown, unknown> & Partial<InternalToolDefinition>;
  const offered: HarnessToolDefinition = {
    approval: entry.approval,
    availableInSubagents: entry.availableInSubagents,
    deferred: entry.deferred,
    description: entry.description,
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
  if (isWorkflowToolDefinition(authored)) return workflowTool(source, offered, authored);
  return {
    ...offered,
    endsTurn: entry.endsTurn,
    execute: createToolExecuteWithAuth({
      execute: (input, context) => entry.execute(input as never, context),
      scope: name,
    }),
  };
}

/**
 * A `defineWorkflowTool()` a resolver returns. Its calls start the workflow the build compiled
 * from its entry point, so the entry point is a top-level function: the build never sees one
 * written where the resolver runs, and a run that outlives the evaluation couldn't reach it.
 */
function workflowTool(
  source: ToolSource,
  offered: HarnessToolDefinition,
  authored: object,
): HarnessToolDefinition {
  const invalid = `The defineDynamic() in "${source.logicalPath}" returned an invalid workflow tool "${offered.name}".`;
  const [entryPoint] = readWorkflowToolEntryPoints(authored);
  const workflowId =
    entryPoint === undefined
      ? undefined
      : readWorkflowFunctionId(Reflect.get(authored, entryPoint));
  if (entryPoint === undefined || workflowId === undefined) {
    throw new Error(
      `${invalid} Its entry point is not a compiled workflow. Pass execute, task, or serve a top-level "async function" that starts with "use workflow"; eve can't compile an entry point written inside defineDynamic().`,
    );
  }
  if (Reflect.get(authored, "endsTurn") !== undefined) {
    throw new Error(
      `${invalid} "endsTurn" is not supported on defineWorkflowTool(). Workflow tools resume the turn when they finish; use defineTool() for a tool that ends the turn.`,
    );
  }
  if (entryPoint === "serve") {
    assertNoOwnTaskIdInput(serializeInputSchema(offered.inputSchema as ToolSchemaSource), invalid);
  }
  return createWorkflowToolHarnessDefinition({
    definition: {
      ...offered,
      behavior: {
        availability: [],
        handling: {
          kind: "dispatch",
          target: { entryPoint, kind: "workflow-tool-call", workflowId },
        },
      },
    },
    workflowId,
  });
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
