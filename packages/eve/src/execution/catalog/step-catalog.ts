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
import type { ResolvedChannelDefinition, ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { refineJsonSchema } from "#tools/schema.js";

import { connectionEntry, connectionSignInEntry } from "./connection-entry.js";
import { createSkillLoader, type CatalogSkill } from "./skills.js";

const ENDS_TURN_TOOL_NOTE =
  "Calling this tool ends your turn once it succeeds, after any other tool calls in the same step finish: do not write a reply, and you will not see those calls' results. If it fails, you will see the error and can continue.";

export interface Callable {
  readonly channels: readonly ResolvedChannelDefinition[];
  readonly entries: HarnessToolMap;
  readonly deferred: HarnessToolMap;
  readonly connections: readonly ResolvedConnectionDefinition[];
  readonly skills: ReadonlyMap<string, CatalogSkill>;
  readonly registry: ConnectionRegistry | undefined;
  get(name: string): HarnessToolDefinition | undefined;
  describe(definition: HarnessToolDefinition): string;
}

export interface StepCatalog extends HarnessToolLookup {
  readonly advertised: HarnessToolMap;
  readonly connections: readonly ResolvedConnectionDefinition[];
  readonly deferred: HarnessToolMap;
  readonly entries: HarnessToolMap;
  readonly skills: ReadonlyMap<string, CatalogSkill>;
  describe(definition: HarnessToolDefinition): string;
  readonly resolve: CallResolver;
}

export interface CatalogInput {
  readonly table: ToolTable;
  readonly ctx: ContextReader;
  readonly endsTurn: boolean;
  readonly session: Pick<HarnessSession, "rootSessionId">;
}

export function callableOf(input: CatalogInput): Callable {
  const { connections, skills } = input.table;
  const bundle = compiledBundleOf(input.ctx);
  const agentApproval = bundle === undefined ? undefined : resolveAgentApproval(bundle);
  const entries = withAgentApprovalOnEntries(
    new Map([
      ...[...input.table.entries]
        .filter(
          ([, entry]) => entry.route === undefined && isVisible(entry.definition, input.session),
        )
        .map(([name, entry]): [string, HarnessToolDefinition] => [name, entry.definition]),
      ...[...input.table.entries].flatMap(([, entry]) =>
        (entry.route?.owns ?? []).map((owned): [string, HarnessToolDefinition] => [
          owned.name,
          owned,
        ]),
      ),
    ]),
    agentApproval,
  );
  const registry = input.ctx.get(ConnectionRegistryKey);
  const versions = dynamicConnectionVersions(input.ctx);
  return {
    channels: bundle?.resolvedAgent.channels ?? [],
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
      if (isVisible(entry.definition, input.session))
        advertised.set(name, routeTool(entry.definition, entry.route, catalog));
    } else {
      const definition = callable.entries.get(name);
      if (definition !== undefined && definition.deferred !== true)
        advertised.set(name, definition);
    }
  }
  return catalog;
}

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
  versions: ReadonlyMap<string, string>,
  agentApproval: ApprovalPolicy | undefined,
): HarnessToolDefinition | undefined {
  for (const connection of connections) {
    const version = versions.get(connection.connectionName);
    const versioned = (entry: HarnessToolDefinition) =>
      version === undefined ? entry : { ...entry, version };
    if (name === connection.connectionName) {
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
