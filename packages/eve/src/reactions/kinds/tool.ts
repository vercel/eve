import { assertNotConnectionOwned } from "#connections/ownership.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { TOOL_SLUG_PATTERN, TOOL_SLUG_RULE } from "#discover/grammar.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createLogger } from "#internal/logging.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { workflowIdForHandling } from "#runtime/subagents/workflow-reference.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
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
import { authoredResolve, type Reaction } from "../reaction.js";
import { slotsOf } from "../runner.js";
import { canonicalJson } from "../state.js";

const log = createLogger("dynamic-tools");

/** A `defineDynamic()` in `agent/tools/`: one tool named after the file, or a map of them. */
export function toolReaction(resolver: ResolvedDynamicToolResolver): Reaction {
  return {
    contribute: (result, { ctx }) => {
      const tools = namedTools(resolver, result).map(({ entry, name }) => {
        assertToolNameAvailable(ctx, resolver, name);
        return liveTool(name, entry);
      });
      if (tools.length === 0) return { value: null };
      return { live: tools, value: tools.map(declaration) };
    },
    id: `tool:${resolver.extensionNamespace ?? ""}:${resolver.slug}`,
    kind: "tool",
    label: resolver.logicalPath,
    reconcile: (recorded, rebuilt) => reconcileTools(resolver, recorded, rebuilt),
    resolve: authoredResolve(resolver.logicalPath, resolver.resolve, {
      framework: resolver.framework,
    }),
    select: resolver.select as Reaction["select"],
  };
}

/**
 * Every dynamic tool the session's slots hold, in run order. The first reaction to name a tool
 * keeps it; a later one that names it again is logged and left out.
 */
export function dynamicTools(ctx: Pick<ContextReader, "get"> | undefined): HarnessToolDefinition[] {
  const tools = new Map<string, HarnessToolDefinition>();
  for (const { id, live } of slotsOf(ctx, "tool")) {
    for (const tool of (live as readonly HarnessToolDefinition[] | undefined) ?? []) {
      if (tools.has(tool.name)) {
        log.error(`Dynamic tool "${tool.name}" from "${id}" collides with another dynamic tool.`);
        continue;
      }
      tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

/** The names of the dynamic tools the session's slots hold, live or not. */
export function dynamicToolNames(ctx: Pick<ContextReader, "get"> | undefined): readonly string[] {
  return slotsOf(ctx, "tool").flatMap(({ slot }) =>
    Array.isArray(slot.value) ? slot.value.map((tool) => (tool as { name: string }).name) : [],
  );
}

function namedTools(
  resolver: ResolvedDynamicToolResolver,
  value: unknown,
): readonly { readonly name: string; readonly entry: DynamicToolEntry }[] {
  if (value === null || value === undefined) return [];
  const assertOrdinaryTool = (entry: unknown): void => {
    if (isWorkflowToolDefinition(entry)) {
      throw new Error(
        `Dynamic tool resolver "${resolver.logicalPath}" cannot return defineWorkflowTool(). Workflow tools must be static tools; use defineTool() for dynamic entries.`,
      );
    }
  };
  assertOrdinaryTool(value);
  if (isBrandedToolEntry(value)) return [{ entry: value as DynamicToolEntry, name: resolver.slug }];
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Dynamic tool resolver "${resolver.logicalPath}" must return defineTool(), a map of defineTool() values, or null.`,
    );
  }
  const prefix =
    resolver.extensionNamespace === undefined ? "" : `${resolver.extensionNamespace}__`;
  return Object.entries(value).map(([key, entry]) => {
    assertOrdinaryTool(entry);
    if (!isBrandedToolEntry(entry)) {
      throw new Error(
        `Dynamic tool resolver "${resolver.logicalPath}" returned "${key}" without defineTool(). Wrap every dynamic tool entry in defineTool().`,
      );
    }
    const name = `${prefix}${key}`;
    if (!TOOL_SLUG_PATTERN.test(name)) {
      throw new Error(
        `Dynamic tool resolver "${resolver.logicalPath}" returned illegal tool name "${name}". ${TOOL_SLUG_RULE}`,
      );
    }
    const reservation = eveNamespaceReservation(name);
    if (reservation !== undefined) {
      throw new Error(
        `Dynamic tool resolver "${resolver.logicalPath}" returned the reserved tool name "${name}". ${reservation}; rename the map key.`,
      );
    }
    return { entry: entry as DynamicToolEntry, name };
  });
}

/**
 * The agent's workflow tools and agents run after the model step, so a dynamic tool, which runs in
 * it, can't take their names. Nor can a connection's.
 */
function assertToolNameAvailable(
  ctx: ContextContainer,
  resolver: ResolvedDynamicToolResolver,
  name: string,
): void {
  assertNotConnectionOwned({
    connectionNames: ctx.get(ConnectionRegistryKey)?.getConnectionNames() ?? [],
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
      `Dynamic tool "${name}" from resolver "${resolver.logicalPath}" collides with the workflow tool or agent "${name}". Rename the map key.`,
    );
  }
}

function liveTool(name: string, authored: DynamicToolEntry): HarnessToolDefinition {
  const entry = authored as ToolDefinition<unknown, unknown>;
  const definition = entry as ToolDefinition<unknown, unknown> & Partial<InternalToolDefinition>;
  return {
    approval: entry.approval,
    approvalKey: entry.approvalKey,
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

/**
 * The model was offered the declarations the slot recorded, so those are the tools: a rebuilt tool
 * whose declaration still matches keeps its code, and one that changed, or is gone, fails its calls
 * rather than running code the model wasn't offered. That includes calls parked for an approval.
 */
function reconcileTools(
  resolver: ResolvedDynamicToolResolver,
  recorded: unknown,
  rebuilt: { readonly live?: unknown },
): readonly HarnessToolDefinition[] {
  const live = new Map(
    ((rebuilt.live as readonly HarnessToolDefinition[] | undefined) ?? []).map((tool) => [
      tool.name,
      tool,
    ]),
  );
  return ((recorded ?? []) as readonly JsonObject[]).map((offered) => {
    const name = offered.name as string;
    const tool = live.get(name);
    if (tool !== undefined && canonicalJson(declaration(tool)) === canonicalJson(offered)) {
      return tool;
    }
    log.error(`Dynamic tool "${name}" changed since it was offered; its calls fail.`, {
      resolver: resolver.logicalPath,
    });
    return changedTool(offered);
  });
}

/** A tool as it was offered, whose calls fail because its code no longer matches the offer. */
function changedTool(offered: JsonObject): HarnessToolDefinition {
  const name = offered.name as string;
  return {
    description: offered.description as string,
    execute: async () => {
      throw new Error(`Tool "${name}" changed since it was offered.`);
    },
    inputSchema: toInputSchema(offered.inputSchema as ToolSchemaSource),
    name,
    ...(offered.outputSchema === undefined
      ? {}
      : { outputSchema: toOutputSchema(offered.outputSchema as ToolSchemaSource) }),
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
    ...(tool.deferred === true ? { deferred: true } : {}),
    ...(tool.endsTurn === true ? { endsTurn: true } : {}),
    ...(tool.availableInSubagents === false ? { availableInSubagents: false } : {}),
  };
}
