/**
 * The step's catalog: one table of every entry a model step can reach. Direct
 * entries go into the model's tool list next to `eve__search` and
 * `eve__execute` when the agent has them; deferred entries and connection
 * tools are reached through `eve__execute`, and every skill loads through it.
 * A call resolves to its entry here and then runs exactly as a direct call
 * would, so only model history ever says `eve__execute`.
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
import { EXECUTE_TOOL_NAME, SEARCH_TOOL_NAME, SKILL_ENTRY_NAME } from "#protocol/catalog-tools.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { skillTarget } from "#shared/action-request-name.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
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

const EXECUTE_DESCRIPTION = [
  `Call a tool that is not in your tool list, using the exact name ${SEARCH_TOOL_NAME} returns`,
  "and `input` matching its signature, or load a skill by name with `skill`.",
  "Prefer connected services over web search or general knowledge when a request relates to them.",
].join(" ");

const SKILL_EXECUTE_DESCRIPTION =
  "Load one of your listed skills by name with `skill`, then follow the instructions it returns.";

const SKILL_EXECUTE_INPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: { skill: { type: "string", description: "The name of a listed skill." } },
  required: ["skill"],
  additionalProperties: false,
};

// Providers reject a top-level union, so `tool` and `skill` are both optional
// here and validation requires exactly one.
const EXECUTE_INPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      description: `The tool's exact name, as ${SEARCH_TOOL_NAME} returns it.`,
    },
    input: {
      type: "object",
      description: "Arguments matching the tool's signature. Defaults to {}.",
    },
    skill: { type: "string", description: "The name of a skill to load, instead of a tool." },
  },
  additionalProperties: false,
};

/** Which of `eve__search` and `eve__execute` an agent gets. */
interface CatalogTools {
  readonly execute: boolean;
  readonly search: boolean;
}

/**
 * `eve__search` comes with anything it could find: a deferred tool, agent, or
 * skill, a connection, or a resolver that may add any of these at runtime.
 * `eve__execute` comes with it, or alone when skills are all there is to
 * reach, since skills load only through it. Both follow from what the agent
 * declares, never from what a step's resolvers returned, so the tool list is
 * fixed for a deployment and never changes within a session. An agent with
 * none of these has neither tool, and pays nothing for the catalog.
 */
function catalogToolsFor(
  agentTools: readonly HarnessToolDefinition[],
  bundle: CompiledBundle | undefined,
): CatalogTools {
  const agent = bundle?.resolvedAgent;
  const skills = agent?.skills ?? [];
  const resolvers = [
    agent?.dynamicToolResolvers,
    agent?.dynamicSkillResolvers,
    agent?.dynamicConnectionResolvers,
    bundle?.subagentRegistry.dynamicResolvers,
  ];
  const search =
    agentTools.some((definition) => definition.deferred === true) ||
    skills.some((skill) => skill.deferred === true) ||
    (agent?.connections ?? []).length > 0 ||
    resolvers.some((declared) => (declared?.length ?? 0) > 0);
  return { execute: search || skills.length > 0, search };
}

export interface StepCatalog extends HarnessToolLookup {
  /** The model's tool list: direct entries, then `eve__search` and `eve__execute` when the agent has them. */
  readonly advertised: HarnessToolMap;
  readonly connections: readonly ResolvedConnectionDefinition[];
  /** Entries reached only through `eve__execute`, connection tools aside. */
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
   * Resolves a model tool call to the entry it runs. An `eve__execute` call
   * that names a deferred entry becomes the call to that entry, and one that
   * names a skill becomes the call to load it; any other call runs the listed
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
  // Listed tools include `eve__search` and `eve__execute`, so `eve__execute` naming one of
  // them says to call it directly rather than that it does not exist.
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
      if (toolCall.toolName !== EXECUTE_TOOL_NAME || !catalogTools.execute) {
        const definition = advertised.get(toolCall.toolName);
        return definition === undefined ? undefined : { call: toolCall, definition };
      }
      const tool = toolTarget(toolCall.input);
      const skill = skillTarget(toolCall.input);
      if (skill !== undefined) {
        if (tool !== undefined || !skills.has(skill)) return undefined;
        const call = { ...toolCall, input: { skill }, toolName: SKILL_ENTRY_NAME };
        return { call, definition: skillLoader };
      }
      const definition = tool === undefined ? undefined : toolEntry(tool);
      if (tool === undefined || definition?.deferred !== true) return undefined;
      return { call: asEntryCall(toolCall, tool), definition };
    },
    skills,
  };
  if (catalogTools.search) {
    const search = createSearchTool({
      deferred: [...deferred.values()],
      describe,
      registry,
      skills: [...skills.values()].filter((skill) => skill.deferred),
    });
    advertised.set(search.name, search);
  }
  if (catalogTools.execute) {
    advertised.set(EXECUTE_TOOL_NAME, createExecuteTool(catalog, toolEntry, catalogTools.search));
  }
  return catalog;
}

/** The tool an `eve__execute` input names, if it names one. */
function toolTarget(input: unknown): string | undefined {
  return isObject(input) && typeof input.tool === "string" ? input.tool : undefined;
}

/** `eve__execute({ tool, input })` as the call to `tool` with `input`. */
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
// execute
// ---------------------------------------------------------------------------

/**
 * The model sees one fixed schema. Validation resolves the named entry and
 * checks `input` against that entry's own schema, so a call that reaches
 * `eve__execute` always names a catalog entry with valid input or a skill, as
 * a direct call names a listed tool. Without `eve__search` there is nothing to
 * call but skills, so the tool takes only `skill` and says nothing of tools.
 */
function createExecuteTool(
  catalog: StepCatalog,
  toolEntry: (name: string) => HarnessToolDefinition | undefined,
  searchable: boolean,
): HarnessToolDefinition {
  return {
    description: searchable ? EXECUTE_DESCRIPTION : SKILL_EXECUTE_DESCRIPTION,
    execute: (input: unknown, options: ToolExecuteOptions) => {
      const resolved = catalog.resolve({ input, toolName: EXECUTE_TOOL_NAME });
      // Input validation resolves every call before the SDK runs it.
      if (resolved === undefined) {
        throw new Error(`An ${EXECUTE_TOOL_NAME} call ran without a resolved entry.`);
      }
      return runEntryCall(resolved, options);
    },
    frameworkTool: true,
    inputSchema: refineJsonSchema(
      searchable ? EXECUTE_INPUT_SCHEMA : SKILL_EXECUTE_INPUT_SCHEMA,
      (value) => resolveExecuteInput(catalog, toolEntry, value as ExecuteInput, searchable),
    ),
    name: EXECUTE_TOOL_NAME,
  };
}

interface ExecuteInput {
  readonly input?: unknown;
  readonly skill?: string;
  readonly tool?: string;
}

async function resolveExecuteInput(
  catalog: StepCatalog,
  toolEntry: (name: string) => HarnessToolDefinition | undefined,
  { input, skill, tool }: ExecuteInput,
  searchable: boolean,
): Promise<StandardSchemaV1.Result<ExecuteInput>> {
  if (skill !== undefined) {
    if (tool !== undefined) return failure("skill", "Pass either `tool` or `skill`, not both.");
    if (!isEmptyInput(input)) {
      return failure("input", "A skill takes no `input`; pass `input` only with `tool`.");
    }
    if (catalog.skills.has(skill)) return { value: { skill } };
    const connections = catalog.connections.map((connection) => connection.connectionName);
    return failure("skill", unknownSkillMessage(skill, catalog.skills, connections, searchable));
  }
  if (!searchable) return failure("skill", "Pass `skill`, the name of a listed skill.");
  if (tool === undefined) return failure("tool", "Pass `tool`, or `skill` to load a skill.");
  const definition = toolEntry(tool);
  if (definition === undefined) return failure("tool", unknownEntryMessage(tool, catalog));
  if (definition.deferred !== true) {
    return failure("tool", `"${tool}" is in your tool list; call it directly.`);
  }
  const checked = await checkToolCallInput(definition, input, "");
  if (checked.kind === "threw") throw checked.error;
  if (checked.kind === "invalid") {
    // A connection tool's validation reports its own signature; every other entry gets one here.
    const issues = isConnectionTool(tool, catalog.connections)
      ? checked.issues
      : [...checked.issues, { message: `Signature: ${entrySignature(definition)}` }];
    // The entry's issues rather than its message, so the SDK's report is the only wrapper.
    return {
      issues: issues.map(({ message, path = [] }) => ({ message, path: ["input", ...path] })),
    };
  }
  return { value: { input: checked.value, tool } };
}

function isConnectionTool(
  name: string,
  connections: readonly ResolvedConnectionDefinition[],
): boolean {
  return connections.some(({ connectionName }) =>
    name.startsWith(connectionToolName(connectionName, "")),
  );
}

/** `input` defaults to {}, so an empty object is the same as no input. */
function isEmptyInput(input: unknown): boolean {
  return input === undefined || (isObject(input) && Object.keys(input).length === 0);
}

function failure(path: keyof ExecuteInput, message: string): StandardSchemaV1.FailureResult {
  return { issues: [{ message, path: [path] }] };
}

function unknownEntryMessage(name: string, catalog: StepCatalog): string {
  if (catalog.skills.has(name)) {
    return `"${name}" is a skill; load it with ${EXECUTE_TOOL_NAME}({ skill: "${name}" }).`;
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
