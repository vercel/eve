/**
 * The step's catalog: what a model step can run, and how the model reaches it. The step's tools
 * that aren't deferred go into the model's tool list, in the order its definitions made them,
 * routes such as `eve__tool` among them, whose calls become calls to the entries they name. A call
 * resolves to its entry here and then runs exactly as a direct call would, so only model history
 * ever names a route.
 */

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { ApprovalPolicy } from "#approval/definition.js";
import { withAgentApprovalOnEntries } from "#approval/agent.js";
import { resolveAgentApproval } from "#execution/effective-agent-config.js";
import { connectionToolName } from "#connections/ownership.js";
import { dynamicConnectionVersions } from "#definitions/connections.js";
import type { Route, ToolTable } from "#definitions/definition.js";
import type { ContextReader } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { startsTasks } from "#execution/tasks/tool-entry-point.js";
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
import { SKILL_ENTRY_NAME } from "#protocol/catalog-tools.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { compiledBundleOf } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { refineJsonSchema } from "#tools/schema.js";

import { connectionEntry, connectionSignInEntry } from "./connection-entry.js";
import { createSkillLoader, type CatalogSkill } from "./skills.js";

/** Appended to the model-facing description of every tool with `endsTurn: true`. */
const ENDS_TURN_TOOL_NOTE =
  "Calling this tool ends your turn once it succeeds: do not write a reply or call other tools in the same step. If it fails, you will see the error and can continue.";

/** What a step can run: its tools as the session sees them, with its connections and skills. */
export interface Callable {
  /** Every direct and deferred entry the session sees, connection tools aside. */
  readonly entries: HarnessToolMap;
  /** Entries the model's tool list leaves out, connection tools aside. */
  readonly deferred: HarnessToolMap;
  readonly connections: readonly ResolvedConnectionDefinition[];
  /** Every skill the session can load, deferred or not. */
  readonly skills: ReadonlyMap<string, CatalogSkill>;
  /**
   * The step's connections, read once: a route's validation runs while the SDK parses the
   * stream, where the context store may not be active.
   */
  readonly registry: ConnectionRegistry | undefined;
  /** An entry by name: one of `entries`, or a connection's tool or sign-in. */
  get(name: string): HarnessToolDefinition | undefined;
  /** An entry's description as the model reads it, with the notes eve appends. */
  describe(definition: HarnessToolDefinition): string;
}

export interface StepCatalog extends HarnessToolLookup {
  /** The model's tool list: every entry that isn't deferred, routes among them. */
  readonly advertised: HarnessToolMap;
  readonly connections: readonly ResolvedConnectionDefinition[];
  /** Entries reached only through a route, connection tools aside. */
  readonly deferred: HarnessToolMap;
  /** Every direct and deferred entry the session sees, connection tools aside. */
  readonly entries: HarnessToolMap;
  /** Every skill the session can load, deferred or not. */
  readonly skills: ReadonlyMap<string, CatalogSkill>;
  /** An entry's description as the model reads it, with the notes eve appends. */
  describe(definition: HarnessToolDefinition): string;
  /**
   * Resolves a model tool call to the entry it runs: a route's call becomes the call to the entry
   * it names, and any other call runs the listed tool it names. A call that reaches none of these
   * resolves to nothing.
   */
  readonly resolve: CallResolver;
}

/** What a step's tools are, and where it runs them. */
export interface CatalogInput {
  /** What the step's definitions offer: tools by name, connections, and skills. */
  readonly table: ToolTable;
  readonly ctx: ContextReader;
  /** Whether `endsTurn` applies: a root turn without an output schema. */
  readonly endsTurn: boolean;
  readonly session: Pick<HarnessSession, "rootSessionId">;
}

/** What a step's tools can run, keeping only what the session sees: routes run nothing. */
export function callableOf(input: CatalogInput): Callable {
  const { connections, skills } = input.table;
  const bundle = compiledBundleOf(input.ctx);
  const agentApproval = bundle === undefined ? undefined : resolveAgentApproval(bundle);
  // Only what this session sees, so a delegated session of the same agent doesn't reach or search
  // for root-only entries. Every entry runs under the agent-wide approval policy.
  const entries = withAgentApprovalOnEntries(
    new Map(
      [...input.table.entries]
        .filter(
          ([, entry]) => entry.route === undefined && isVisible(entry.definition, input.session),
        )
        .map(([name, entry]) => [name, entry.definition]),
    ),
    agentApproval,
  );
  const registry = input.ctx.get(ConnectionRegistryKey);
  const versions = dynamicConnectionVersions(input.ctx);
  return {
    connections,
    deferred: new Map([...entries].filter(([, definition]) => definition.deferred === true)),
    describe: (definition) => describeEntry(definition, input.endsTurn),
    entries,
    get: (name) =>
      entries.get(name) ??
      (registry === undefined
        ? undefined
        : connectionEntryNamed(name, registry, connections, versions, agentApproval)),
    registry,
    skills,
  };
}

/** The step's catalog: what its tools can run, and the model's tool list. */
export function buildStepCatalog(input: CatalogInput): StepCatalog {
  const callable = callableOf(input);
  const skillLoader = createSkillLoader(callable.skills);
  const get = (name: string) => (name === SKILL_ENTRY_NAME ? skillLoader : callable.get(name));
  const routes = new Map(
    [...input.table.entries].flatMap(([name, { route }]) =>
      route === undefined ? [] : [[name, route] as const],
    ),
  );
  const advertised: Map<string, HarnessToolDefinition> = new Map();
  const catalog: StepCatalog = {
    advertised,
    connections: callable.connections,
    deferred: callable.deferred,
    describe: callable.describe,
    entries: callable.entries,
    get,
    resolve: (toolCall) => {
      const route = routes.get(toolCall.toolName);
      if (route === undefined) {
        const definition = advertised.get(toolCall.toolName);
        return definition === undefined ? undefined : { call: toolCall, definition };
      }
      const target = route.target(toolCall.input);
      if ("issue" in target) return undefined;
      const definition = get(target.name);
      return definition === undefined
        ? undefined
        : { call: { ...toolCall, input: target.input, toolName: target.name }, definition };
    },
    skills: callable.skills,
  };
  for (const [name, entry] of input.table.entries) {
    if (entry.route !== undefined) {
      advertised.set(name, routeTool(entry.definition, entry.route, catalog));
    } else {
      const definition = callable.entries.get(name);
      if (definition !== undefined && definition.deferred !== true)
        advertised.set(name, definition);
    }
  }
  return catalog;
}

/**
 * The model sees the route's schema. Validation resolves the entry it names and checks the
 * entry's input against the entry's own schema, so a route call that runs always reaches an entry,
 * with valid input.
 */
function routeTool(
  shown: HarnessToolDefinition,
  route: Route,
  catalog: StepCatalog,
): HarnessToolDefinition {
  const { name } = shown;
  return {
    ...shown,
    execute: (input: unknown, options: ToolExecuteOptions) =>
      runResolved(catalog, { input, toolName: name }, options),
    inputSchema: refineJsonSchema(route.inputSchema, async (value) => {
      const target = route.target(value);
      if ("issue" in target) return failure([target.path], target.issue);
      const entry = catalog.get(target.name);
      if (entry === undefined)
        return failure([], `${name} reaches no entry named "${target.name}".`);
      const checked = await checkToolCallInput(entry, target.input, "");
      if (checked.kind === "threw") throw checked.error;
      if (checked.kind === "invalid") {
        const at = target.at === undefined ? [] : [target.at];
        // The entry's issues rather than its message, so the SDK's report is the only wrapper.
        return {
          issues: (route.explain?.(entry, checked.issues) ?? checked.issues).map(
            ({ message, path = [] }) => ({ message, path: [...at, ...path] }),
          ),
        };
      }
      return {
        value:
          target.at === undefined
            ? value
            : { ...(value as Record<string, unknown>), [target.at]: checked.value },
      };
    }),
    name,
  };
}

/**
 * Whether the session offers tasks: one of the agent's own tools it sees starts them, or the agent
 * resolves subagents at runtime. Both are fixed by the deployment.
 */
export function sessionOffersTasks(input: {
  readonly ctx: ContextReader;
  readonly session: Pick<HarnessSession, "rootSessionId">;
  readonly tools: readonly HarnessToolDefinition[];
}): boolean {
  return (
    (compiledBundleOf(input.ctx)?.subagentRegistry.dynamicResolvers.length ?? 0) > 0 ||
    input.tools.some(
      (definition) => isVisible(definition, input.session) && startsTasks(definition),
    )
  );
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

function describeEntry(definition: HarnessToolDefinition, endsTurn: boolean): string {
  return endsTurn && definition.endsTurn === true
    ? `${definition.description}\n\n${ENDS_TURN_TOOL_NOTE}`.trimStart()
    : definition.description;
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
  versions: ReadonlyMap<string, string>,
  agentApproval: ApprovalPolicy | undefined,
): HarnessToolDefinition | undefined {
  for (const connection of connections) {
    const version = versions.get(connection.connectionName);
    const versioned = (entry: HarnessToolDefinition) =>
      version === undefined ? entry : { ...entry, version };
    if (name === connection.connectionName) {
      // Signing in acts on nothing remote, so the agent's policy doesn't gate it.
      return versioned(connectionSignInEntry(registry, connection));
    }
    const prefix = connectionToolName(connection.connectionName, "");
    if (name.length > prefix.length && name.startsWith(prefix)) {
      return versioned(
        connectionEntry(registry, connection, name.slice(prefix.length), agentApproval),
      );
    }
  }
  return undefined;
}

function failure(path: readonly string[], message: string): StandardSchemaV1.FailureResult {
  return { issues: [{ message, path: [...path] }] };
}
