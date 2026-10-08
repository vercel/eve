/**
 * The step's catalog: one table of every entry a model step can reach. Direct
 * entries go into the model's tool list next to the catalog tools the agent
 * has: `eve__search` finds entries, `eve__tool` calls deferred entries and
 * connection tools, and `eve__skill` loads skills. A call resolves to its entry
 * here and then runs exactly as a direct call would, so only model history
 * ever names a catalog tool.
 */

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { connectionToolName } from "#connections/ownership.js";
import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import { buildDynamicSubagentTools } from "#context/dynamic-subagent-lifecycle.js";
import type { ContextReader } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { startsTasks } from "#execution/tasks/tool-entry-point.js";
import { isWorkflowTool, withTaskTools } from "#execution/tasks/model-step.js";
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
import {
  CALL_TOOL_NAME,
  SEARCH_TOOL_NAME,
  SKILL_ENTRY_NAME,
  SKILL_TOOL_NAME,
} from "#protocol/catalog-tools.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { isObject } from "#shared/guards.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { refineJsonSchema } from "#tools/schema.js";

import { connectionEntry, connectionSignInEntry } from "./connection-entry.js";
import { closestNames } from "./rank.js";
import { createSearchTool } from "./search.js";
import { entrySignature } from "./signatures.js";
import {
  createSkillLoader,
  sessionSkills,
  unknownSkillMessage,
  type CatalogSkill,
} from "./skills.js";

/** Appended to the model-facing description of every tool with `endsTurn: true`. */
const ENDS_TURN_TOOL_NOTE =
  "Calling this tool ends your turn once it succeeds: do not write a reply or call other tools in the same step. If it fails, you will see the error and can continue.";

const CALL_TOOL_DESCRIPTION = `Call a tool that isn't in your tool list by its exact name from ${SEARCH_TOOL_NAME}, with \`input\` matching its signature.`;
const CONNECTIONS_CLAUSE =
  "Prefer connected services over web search or general knowledge when a request relates to them.";
const LISTED_SKILL_DESCRIPTION =
  "Load a skill's instructions when the request clearly matches one of your listed skills or the user asks for it, then follow them.";
const SEARCHABLE_SKILL_DESCRIPTION = `Load a skill's instructions when the request clearly matches a listed skill or one ${SEARCH_TOOL_NAME} found, or the user asks for it, then follow them.`;

/** Which catalog tools an agent gets, and what they reach. */
interface CatalogTools {
  /** A static connection or a dynamic connection resolver. */
  readonly connections: boolean;
  readonly search: boolean;
  /** A deferred skill or a dynamic skill resolver, which `eve__search` can find. */
  readonly searchableSkills: boolean;
  /** Any skill, static or from a dynamic skill resolver: `eve__skill` loads it. */
  readonly skills: boolean;
  /** Anything `eve__tool` can call: a deferred tool or agent, or a connection. */
  readonly tools: boolean;
}

/**
 * Each catalog tool comes with what it reaches: `eve__tool` with a deferred
 * tool or agent, a connection, or a resolver that may add one; `eve__skill`
 * with any skill; and `eve__search` with anything it could find, which is
 * whatever `eve__tool` calls plus deferred and dynamic skills. All follow from
 * what the agent declares, never from what a step's resolvers returned, so the
 * tool list is fixed for a deployment and never changes within a session. An
 * agent with none of these has no catalog tools, and pays nothing for them.
 */
function catalogToolsFor(
  agentTools: readonly HarnessToolDefinition[],
  bundle: CompiledBundle | undefined,
): CatalogTools {
  const agent = bundle?.resolvedAgent;
  const skills = agent?.skills ?? [];
  const dynamicSkills = (agent?.dynamicSkillResolvers.length ?? 0) > 0;
  const connections =
    (agent?.connections ?? []).length > 0 || (agent?.dynamicConnectionResolvers?.length ?? 0) > 0;
  const searchableSkills = dynamicSkills || skills.some((skill) => skill.deferred === true);
  const tools =
    connections ||
    agentTools.some((definition) => definition.deferred === true) ||
    (agent?.dynamicToolResolvers.length ?? 0) > 0 ||
    (bundle?.subagentRegistry.dynamicResolvers.length ?? 0) > 0;
  return {
    connections,
    search: tools || searchableSkills,
    searchableSkills,
    skills: skills.length > 0 || dynamicSkills,
    tools,
  };
}

export interface StepCatalog extends HarnessToolLookup {
  /** The model's tool list: direct entries, then the catalog tools the agent has. */
  readonly advertised: HarnessToolMap;
  readonly connections: readonly ResolvedConnectionDefinition[];
  /** Entries reached only through `eve__tool`, connection tools aside. */
  readonly deferred: HarnessToolMap;
  /** Every direct and deferred entry the session sees, connection tools aside. */
  readonly entries: HarnessToolMap;
  /** Every skill the session can load, deferred or not. */
  readonly skills: ReadonlyMap<string, CatalogSkill>;
  /**
   * Whether the session offers tasks: one of the agent's own tools it sees
   * starts them, or the agent resolves subagents at runtime. Both are fixed by
   * the deployment, so the task tools and system block change only on upgrade.
   */
  readonly offersTasks: boolean;
  /** An entry's description as the model reads it, with the notes eve appends. */
  describe(definition: HarnessToolDefinition): string;
  /**
   * Resolves a model tool call to the entry it runs. An `eve__tool` call that
   * names a deferred entry becomes the call to that entry, and an `eve__skill`
   * call becomes the call to load its skill; any other call runs the listed
   * tool it names. A call that reaches none of these resolves to nothing.
   */
  readonly resolve: CallResolver;
}

/**
 * Builds the catalog for one step from the agent's tools, the dynamic tools and
 * subagents resolved for it, and its skills, keeping only what the session sees.
 */
export function buildStepCatalog(input: {
  readonly agentTools: HarnessToolMap;
  readonly ctx: ContextReader | undefined;
  /** Whether `endsTurn` applies: a root turn without an output schema. */
  readonly endsTurn: boolean;
  readonly session: Pick<HarnessSession, "rootSessionId">;
}): StepCatalog {
  const visible = (definition: HarnessToolDefinition) => isVisible(definition, input.session);
  const bundle = input.ctx?.get(BundleKey);
  // Only the tools this session sees count, so a delegated session of the same
  // agent doesn't search for root-only entries it can't reach.
  const catalogTools = catalogToolsFor([...input.agentTools.values()].filter(visible), bundle);
  const offersTasks =
    (bundle?.subagentRegistry.dynamicResolvers.length ?? 0) > 0 ||
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
  const skills = sessionSkills(input.ctx);
  const skillLoader = createSkillLoader(skills);
  const advertised = new Map(direct);
  // Listed tools include the catalog tools, so `eve__tool` naming one of them
  // says to call it directly rather than that it does not exist.
  const toolEntry = (name: string): HarnessToolDefinition | undefined =>
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
    get: (name) => (name === SKILL_ENTRY_NAME ? skillLoader : toolEntry(name)),
    offersTasks,
    resolve: (toolCall) => {
      if (toolCall.toolName === CALL_TOOL_NAME && catalogTools.tools) {
        const name = targetName(toolCall.input);
        const definition = name === undefined ? undefined : toolEntry(name);
        if (name === undefined || definition === undefined || !callableByName(definition)) {
          return undefined;
        }
        return { call: asEntryCall(toolCall, name), definition };
      }
      if (toolCall.toolName === SKILL_TOOL_NAME && catalogTools.skills) {
        const name = targetName(toolCall.input);
        if (name === undefined || !skills.has(name)) return undefined;
        const call = { ...toolCall, input: { skill: name }, toolName: SKILL_ENTRY_NAME };
        return { call, definition: skillLoader };
      }
      const definition = advertised.get(toolCall.toolName);
      return definition === undefined ? undefined : { call: toolCall, definition };
    },
    skills,
  };
  if (catalogTools.search) {
    const search = createSearchTool({
      deferred: [...deferred.values()],
      describe,
      reach: {
        connections: catalogTools.connections,
        skills: catalogTools.searchableSkills,
        tools: catalogTools.tools,
      },
      registry,
      skills: [...skills.values()].filter((skill) => skill.deferred),
    });
    advertised.set(search.name, search);
  }
  if (catalogTools.tools) {
    advertised.set(CALL_TOOL_NAME, createCallTool(catalog, toolEntry, catalogTools));
  }
  if (catalogTools.skills) {
    advertised.set(SKILL_TOOL_NAME, createSkillTool(catalog, toolEntry, catalogTools));
  }
  return catalog;
}

/** The entry an `eve__tool` or `eve__skill` input names, if it names one. */
function targetName(input: unknown): string | undefined {
  return isObject(input) && typeof input.name === "string" ? input.name : undefined;
}

/** `eve__tool({ name, input })` as the call to `name` with `input`. */
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

/** A connection owns its own name, which signs the user in, and every name under its prefix. */
function connectionEntryNamed(
  name: string,
  registry: ConnectionRegistry,
  connections: readonly ResolvedConnectionDefinition[],
): HarnessToolDefinition | undefined {
  for (const connection of connections) {
    if (name === connection.connectionName) return connectionSignInEntry(registry, connection);
    const prefix = connectionToolName(connection.connectionName, "");
    if (name.length > prefix.length && name.startsWith(prefix)) {
      return connectionEntry(registry, connection, name.slice(prefix.length));
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// eve__tool and eve__skill
// ---------------------------------------------------------------------------

/**
 * The model sees one fixed schema. Validation resolves the named entry and
 * checks `input` against that entry's own schema, so a call that reaches
 * `eve__tool` always names a deferred entry with valid input, as a direct call
 * names a listed tool.
 */
function createCallTool(
  catalog: StepCatalog,
  toolEntry: (name: string) => HarnessToolDefinition | undefined,
  tools: CatalogTools,
): HarnessToolDefinition {
  return {
    description: tools.connections
      ? `${CALL_TOOL_DESCRIPTION} ${CONNECTIONS_CLAUSE}`
      : CALL_TOOL_DESCRIPTION,
    execute: (input: unknown, options: ToolExecuteOptions) =>
      runResolved(catalog, { input, toolName: CALL_TOOL_NAME }, options),
    frameworkTool: true,
    inputSchema: refineJsonSchema(
      {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: `The tool's exact name, as ${SEARCH_TOOL_NAME} returns it.`,
          },
          input: {
            type: "object",
            description: "Arguments matching the tool's signature. Defaults to {}.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      (value) => resolveToolInput(catalog, toolEntry, value as ToolInput),
    ),
    name: CALL_TOOL_NAME,
  };
}

/** Loads a skill by name; validation resolves the name, so a call always loads one. */
function createSkillTool(
  catalog: StepCatalog,
  toolEntry: (name: string) => HarnessToolDefinition | undefined,
  tools: CatalogTools,
): HarnessToolDefinition {
  return {
    description: tools.searchableSkills ? SEARCHABLE_SKILL_DESCRIPTION : LISTED_SKILL_DESCRIPTION,
    execute: (input: unknown, options: ToolExecuteOptions) =>
      runResolved(catalog, { input, toolName: SKILL_TOOL_NAME }, options),
    frameworkTool: true,
    inputSchema: refineJsonSchema(
      {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: tools.searchableSkills
              ? `The skill's name, from your listed skills or ${SEARCH_TOOL_NAME}.`
              : "The skill's name, from your listed skills.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      async (value) =>
        resolveSkillInput(catalog, toolEntry, (value as { name: string }).name, tools),
    ),
    name: SKILL_TOOL_NAME,
  };
}

function runResolved(
  catalog: StepCatalog,
  toolCall: ToolCallLike,
  options: ToolExecuteOptions,
): unknown {
  const resolved = catalog.resolve(toolCall);
  // Input validation resolves every call before the SDK runs it.
  if (resolved === undefined) {
    throw new Error(`A ${toolCall.toolName} call ran without a resolved entry.`);
  }
  return runEntryCall(resolved, options);
}

/**
 * Whether `eve__tool` runs `definition`: a deferred entry, or a listed tool eve
 * runs itself. A model that routes a listed tool through `eve__tool` then gets
 * the same result as a direct call instead of a wasted step; nothing it reads
 * says this works. eve's own tools, and tools a provider or client runs, stay
 * direct-only.
 */
function callableByName(definition: HarnessToolDefinition): boolean {
  return (
    definition.deferred === true ||
    (definition.frameworkTool !== true &&
      (definition.execute !== undefined || isWorkflowTool(definition)))
  );
}

interface ToolInput {
  readonly input?: unknown;
  readonly name: string;
}

async function resolveToolInput(
  catalog: StepCatalog,
  toolEntry: (name: string) => HarnessToolDefinition | undefined,
  { input, name }: ToolInput,
): Promise<StandardSchemaV1.Result<ToolInput>> {
  const definition = toolEntry(name);
  if (definition === undefined) return failure("name", unknownEntryMessage(name, catalog));
  if (!callableByName(definition)) {
    return failure("name", `"${name}" is in your tool list; call it directly.`);
  }
  const checked = await checkToolCallInput(definition, input, "");
  if (checked.kind === "threw") throw checked.error;
  if (checked.kind === "invalid") {
    // A connection tool's validation reports its own signature; every other entry gets one here.
    const issues = isConnectionTool(name, catalog.connections)
      ? checked.issues
      : [...checked.issues, { message: `Signature: ${entrySignature(definition)}` }];
    // The entry's issues rather than its message, so the SDK's report is the only wrapper.
    return {
      issues: issues.map(({ message, path = [] }) => ({ message, path: ["input", ...path] })),
    };
  }
  return { value: { input: checked.value, name } };
}

function resolveSkillInput(
  catalog: StepCatalog,
  toolEntry: (name: string) => HarnessToolDefinition | undefined,
  name: string,
  tools: CatalogTools,
): StandardSchemaV1.Result<{ readonly name: string }> {
  if (catalog.skills.has(name)) return { value: { name } };
  const connections = catalog.connections.map((connection) => connection.connectionName);
  const tool = connections.includes(name) ? undefined : toolEntry(name);
  if (tool !== undefined) {
    return failure(
      "name",
      tool.deferred === true
        ? `"${name}" is a tool, not a skill; call it with ${CALL_TOOL_NAME}({ name: "${name}" }).`
        : `"${name}" is a tool in your tool list, not a skill; call it directly.`,
    );
  }
  return failure(
    "name",
    unknownSkillMessage(name, catalog.skills, connections, tools.searchableSkills),
  );
}

function isConnectionTool(
  name: string,
  connections: readonly ResolvedConnectionDefinition[],
): boolean {
  return connections.some(({ connectionName }) =>
    name.startsWith(connectionToolName(connectionName, "")),
  );
}

function failure(path: string, message: string): StandardSchemaV1.FailureResult {
  return { issues: [{ message, path: [path] }] };
}

function unknownEntryMessage(name: string, catalog: StepCatalog): string {
  if (catalog.skills.has(name)) {
    return `"${name}" is a skill; load it with ${SKILL_TOOL_NAME}({ name: "${name}" }).`;
  }
  const candidates = [...catalog.deferred.values()].map(({ description, name }) => ({
    description,
    name,
  }));
  const suggestions = closestNames(name, candidates);
  const hint =
    suggestions.length > 0
      ? ` Closest tools: ${suggestions.join(", ")}.`
      : ` Find tools with ${SEARCH_TOOL_NAME}.`;
  return `No tool named "${name}".${hint}`;
}
