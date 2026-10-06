/**
 * The step's catalog: one table of every entry a model step can reach. Direct
 * entries go into the model's tool list next to `search` and `execute`;
 * deferred entries and connection tools are reached through `execute`. A call
 * resolves to its entry here and then runs exactly as a direct call would, so
 * only model history ever says `execute`.
 */

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { connectionToolName } from "#connections/ownership.js";
import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import { buildDynamicSubagentTools } from "#context/dynamic-subagent-lifecycle.js";
import type { ContextReader } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { startsTasks } from "#execution/tasks/tool-entry-point.js";
import { withTaskTools } from "#execution/tasks/model-step.js";
import { runEntryCall } from "#harness/execute-call.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { checkToolCallInput } from "#harness/tool-call-io.js";
import type {
  CallResolver,
  HarnessSession,
  HarnessToolLookup,
  HarnessToolMap,
  ToolCallLike,
} from "#harness/types.js";
import { EXECUTE_TOOL_NAME } from "#protocol/catalog-tools.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { refineJsonSchema } from "#tools/schema.js";

import { connectionEntry } from "./connection-entry.js";
import { closestNames } from "./rank.js";
import { createSearchTool } from "./search.js";
import { entrySignature } from "./signatures.js";

const MAX_SUGGESTIONS = 5;

/** Appended to the model-facing description of every tool with `endsTurn: true`. */
const ENDS_TURN_TOOL_NOTE =
  "Calling this tool ends your turn once it succeeds: do not write a reply or call other tools in the same step. If it fails, you will see the error and can continue.";

const EXECUTE_DESCRIPTION = [
  "Call a tool that is not in your tool list, using the exact name search returns",
  "and `input` matching its signature.",
  "Prefer connected services over web search or general knowledge when a request relates to them.",
].join(" ");

const EXECUTE_INPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    tool: { type: "string", description: "The tool's exact name, as search returns it." },
    input: {
      type: "object",
      description: "Arguments matching the tool's signature. Defaults to {}.",
    },
  },
  required: ["tool"],
  additionalProperties: false,
};

export interface StepCatalog extends HarnessToolLookup {
  /** The model's tool list: direct entries, then `search` and `execute`. */
  readonly advertised: HarnessToolMap;
  readonly connections: readonly ResolvedConnectionDefinition[];
  /** Entries reached only through `execute`, connection tools aside. */
  readonly deferred: HarnessToolMap;
  /** Every direct and deferred entry the session sees, connection tools aside. */
  readonly entries: HarnessToolMap;
  /**
   * Whether the session offers tasks: one of the agent's own tools it sees
   * starts them, or the agent resolves subagents at runtime. Both are fixed by
   * the deployment, so the task tools and system block change only on upgrade.
   */
  readonly offersTasks: boolean;
  /** An entry's description as the model reads it, with the notes eve appends. */
  describe(definition: HarnessToolDefinition): string;
  /**
   * Resolves a model tool call to the entry it runs. An `execute` call that
   * names a deferred entry becomes the call to that entry; any other call runs
   * the listed tool it names. A call that reaches neither resolves to nothing.
   */
  readonly resolve: CallResolver;
}

/**
 * Builds the catalog for one step from the agent's tools and the dynamic tools
 * and subagents resolved for it, keeping only what the session sees.
 */
export function buildStepCatalog(input: {
  readonly agentTools: HarnessToolMap;
  readonly ctx: ContextReader | undefined;
  /** Whether `endsTurn` applies: a root turn without an output schema. */
  readonly endsTurn: boolean;
  readonly session: Pick<HarnessSession, "rootSessionId">;
}): StepCatalog {
  const visible = (definition: HarnessToolDefinition) => isVisible(definition, input.session);
  const offersTasks =
    (input.ctx?.get(BundleKey)?.subagentRegistry.dynamicResolvers.length ?? 0) > 0 ||
    [...input.agentTools.values()].some(
      (definition) => visible(definition) && startsTasks(definition),
    );
  const ownEntries = stepEntries(input, visible);
  const entries = offersTasks ? withTaskTools(ownEntries) : ownEntries;
  const direct = new Map<string, HarnessToolDefinition>();
  const deferred = new Map<string, HarnessToolDefinition>();
  for (const [name, definition] of entries) {
    (definition.deferred === true ? deferred : direct).set(name, definition);
  }
  // Read once here: validation runs while the SDK parses the stream, where the
  // context store may not be active.
  const registry = input.ctx?.get(ConnectionRegistryKey);
  const connections = registry?.getConnections() ?? [];
  const advertised = new Map(direct);
  // Listed tools include `search` and `execute`, so `execute` naming one of
  // them says to call it directly rather than that it does not exist.
  const get = (name: string): HarnessToolDefinition | undefined =>
    entries.get(name) ??
    advertised.get(name) ??
    (registry === undefined ? undefined : connectionEntryNamed(name, registry, connections));
  const describe = (definition: HarnessToolDefinition) => describeEntry(definition, input.endsTurn);
  const catalog: StepCatalog = {
    advertised,
    connections,
    deferred,
    describe,
    entries,
    get,
    offersTasks,
    resolve: (toolCall) => {
      if (toolCall.toolName !== EXECUTE_TOOL_NAME) {
        const definition = advertised.get(toolCall.toolName);
        return definition === undefined ? undefined : { call: toolCall, definition };
      }
      const target = executeTarget(toolCall.input);
      const definition = target === undefined ? undefined : get(target);
      if (target === undefined || definition?.deferred !== true) return undefined;
      return { call: asEntryCall(toolCall, target), definition };
    },
  };
  for (const tool of [
    createSearchTool({ deferred: [...deferred.values()], describe, registry }),
    createExecuteTool(catalog),
  ]) {
    advertised.set(tool.name, tool);
  }
  return catalog;
}

/** The entry an `execute` input names, if it names one. */
function executeTarget(input: unknown): string | undefined {
  return isObject(input) && typeof input.tool === "string" ? input.tool : undefined;
}

/** `execute({ tool, input })` as the call to `tool` with `input`. */
function asEntryCall<T extends ToolCallLike>(toolCall: T, toolName: string): T {
  const input = (toolCall.input as { readonly input?: unknown }).input;
  return { ...toolCall, input: input ?? {}, toolName };
}

function describeEntry(definition: HarnessToolDefinition, endsTurn: boolean): string {
  return endsTurn && definition.endsTurn === true
    ? `${definition.description}\n\n${ENDS_TURN_TOOL_NOTE}`.trimStart()
    : definition.description;
}

function stepEntries(
  input: Parameters<typeof buildStepCatalog>[0],
  visible: (definition: HarnessToolDefinition) => boolean,
): Map<string, HarnessToolDefinition> {
  const entries = new Map([...input.agentTools].filter(([, definition]) => visible(definition)));
  if (input.ctx === undefined) return entries;

  for (const subagent of buildDynamicSubagentTools(input.ctx).filter(visible)) {
    entries.set(subagent.name, subagent);
  }
  // Dynamic tools override a same-named authored tool. The first definition of
  // a name wins: step, then turn, then session.
  const dynamicNames = new Set<string>();
  for (const tool of buildDynamicTools(input.ctx).filter(visible)) {
    if (dynamicNames.has(tool.name)) continue;
    dynamicNames.add(tool.name);
    entries.set(tool.name, tool);
  }
  return entries;
}

/** Root-only tools and tools unavailable in subagents are hidden from delegated sessions. */
function isVisible(
  definition: HarnessToolDefinition,
  session: Pick<HarnessSession, "rootSessionId">,
): boolean {
  const rootOnly =
    definition.rootOnly === true ||
    definition.availableInSubagents === false ||
    definition.behavior?.availability.includes("root-session") === true;
  return !rootOnly || session.rootSessionId === undefined;
}

function connectionEntryNamed(
  name: string,
  registry: ConnectionRegistry,
  connections: readonly ResolvedConnectionDefinition[],
): HarnessToolDefinition | undefined {
  for (const connection of connections) {
    const prefix = connectionToolName(connection.connectionName, "");
    if (name.length > prefix.length && name.startsWith(prefix)) {
      return connectionEntry(registry, connection, name.slice(prefix.length));
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

/**
 * The model sees one fixed schema. Validation resolves the named entry and
 * checks `input` against that entry's own schema, so a call that reaches
 * `execute` always names a catalog entry with valid input, as a direct call
 * names a listed tool.
 */
function createExecuteTool(catalog: StepCatalog): HarnessToolDefinition {
  return {
    description: EXECUTE_DESCRIPTION,
    execute: (input: unknown, options: ToolExecuteOptions) => {
      const resolved = catalog.resolve({ input, toolName: EXECUTE_TOOL_NAME });
      // Input validation resolves every call before the SDK runs it.
      if (resolved === undefined) throw new Error("An execute call ran without a resolved entry.");
      return runEntryCall(resolved, options);
    },
    frameworkTool: true,
    inputSchema: refineJsonSchema(EXECUTE_INPUT_SCHEMA, (value) =>
      resolveExecuteInput(catalog, value as ExecuteInput),
    ),
    name: EXECUTE_TOOL_NAME,
  };
}

interface ExecuteInput {
  readonly input?: unknown;
  readonly tool: string;
}

async function resolveExecuteInput(
  catalog: StepCatalog,
  { input, tool }: ExecuteInput,
): Promise<StandardSchemaV1.Result<ExecuteInput>> {
  const definition = catalog.get(tool);
  if (definition === undefined) return failure("tool", unknownEntryMessage(tool, catalog));
  if (definition.deferred !== true) {
    return failure("tool", `"${tool}" is in your tool list; call it directly.`);
  }
  const checked = await checkToolCallInput(definition, input, "");
  if (checked.kind === "threw") throw checked.error;
  if (checked.kind === "invalid") {
    // A connection tool's validation reports its own signature; agent entries get one here.
    const issues = catalog.entries.has(tool)
      ? [...checked.issues, { message: `Signature: ${entrySignature(definition)}` }]
      : checked.issues;
    // The entry's issues rather than its message, so the SDK's report is the only wrapper.
    return {
      issues: issues.map(({ message, path = [] }) => ({ message, path: ["input", ...path] })),
    };
  }
  return { value: { input: checked.value, tool } };
}

function failure(path: keyof ExecuteInput, message: string): StandardSchemaV1.FailureResult {
  return { issues: [{ message, path: [path] }] };
}

function unknownEntryMessage(name: string, catalog: StepCatalog): string {
  const candidates = [...catalog.deferred.values()].map(({ description, name }) => ({
    description,
    name,
  }));
  const suggestions = closestNames(name, candidates, MAX_SUGGESTIONS);
  const hint =
    suggestions.length > 0
      ? ` Closest tools: ${suggestions.join(", ")}.`
      : " Find tools with search.";
  return `No tool named "${name}".${hint}`;
}
