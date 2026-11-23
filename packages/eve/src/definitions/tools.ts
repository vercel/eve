import { assertNotConnectionOwned } from "#connections/ownership.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { TOOL_SLUG_PATTERN, TOOL_SLUG_RULE } from "#shared/name-grammar.js";
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
import {
  isWorkflowToolDefinition,
  readWorkflowToolEntryPoints,
} from "#tools/workflow-definition.js";
import type { WorkflowToolEntryPoint } from "#tools/workflow-entry-point.js";
import { readWorkflowFunctionId } from "#shared/workflow-function-id.js";
import { createWorkflowToolHarnessDefinition } from "#execution/tools/workflow/harness-definition.js";
import { assertNoOwnTaskIdInput } from "#internal/authored-definition/schema-backed.js";
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

export const staticTools: Definition = {
  contribute: ({ step }) => ({
    tools: () => ({ entries: toolEntries([...(step?.agentTools.values() ?? [])], "eve.tools") }),
  }),
  id: "eve.tools",
  label: "the agent's tools",
};

export function toolDefinition(resolver: ResolvedDynamicDefinition<"tool">): Definition {
  return toolsDefinition(resolver, authoredEvaluate(resolver.evaluate));
}

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

export interface ToolSource {
  readonly extensionNamespace?: string;
  readonly logicalPath: string;
  readonly slug: string;
}

export function contributeTools(source: ToolSource, result: unknown, ctx: ContextContainer): Kept {
  const tools = namedTools(source, result).map(({ entry, name }) => {
    assertToolNameAvailable(ctx, source, name);
    return liveTool(source, name, entry);
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
  return namedEntries(source, value, TOOLS) as readonly {
    readonly name: string;
    readonly entry: DynamicToolEntry;
  }[];
}

interface CompiledWorkflow {
  readonly entryPoint: WorkflowToolEntryPoint;
  readonly workflowId: string;
}

function compiledWorkflow(source: ToolSource, name: string, entry: object): CompiledWorkflow {
  if (isFrameworkTool(entry)) {
    throw new Error(
      `The defineDynamic() in "${source.logicalPath}" returned eve's built-in workflow tool "${name}", which only works as a static tool. Export it from its own file under agent/tools/ instead.`,
    );
  }
  const [entryPoint] = readWorkflowToolEntryPoints(entry);
  const workflowId =
    entryPoint === undefined ? undefined : readWorkflowFunctionId(Reflect.get(entry, entryPoint));
  if (entryPoint === undefined || workflowId === undefined) {
    throw new Error(
      `The defineDynamic() in "${source.logicalPath}" returned workflow tool "${name}" whose entry point isn't a compiled workflow. Declare it as a top-level async function that starts with "use workflow", and pass that function to defineWorkflowTool() as execute, task, or serve.`,
    );
  }
  if (Reflect.get(entry, "endsTurn") !== undefined && entryPoint !== "execute") {
    throw new Error(
      `The defineDynamic() in "${source.logicalPath}" returned workflow tool "${name}" with "endsTurn", which applies only to execute().`,
    );
  }
  if (entryPoint === "serve") {
    assertNoOwnTaskIdInput(
      serializeInputSchema(Reflect.get(entry, "inputSchema") as ToolSchemaSource),
      `The defineDynamic() in "${source.logicalPath}" returned workflow tool "${name}" whose`,
    );
  }
  return { entryPoint, workflowId };
}

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

function liveTool(
  source: ToolSource,
  name: string,
  authored: DynamicToolEntry,
): HarnessToolDefinition {
  const entry = authored as ToolDefinition<unknown, unknown>;
  const definition = entry as ToolDefinition<unknown, unknown> & Partial<InternalToolDefinition>;
  const common = {
    approval: entry.approval,
    availableInSubagents: entry.availableInSubagents,
    deferred: entry.deferred,
    description: entry.description,
    endsTurn: entry.endsTurn,
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
  if (isWorkflowToolDefinition(entry)) {
    const { entryPoint, workflowId } = compiledWorkflow(source, name, entry);
    return createWorkflowToolHarnessDefinition({
      definition: {
        ...common,
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
  return {
    ...common,
    execute: createToolExecuteWithAuth({
      execute: (input, context) => entry.execute(input as never, context),
      scope: name,
    }),
  };
}

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
