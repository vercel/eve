/**
 * Building blocks for tests of the step catalog: agent entries of each kind,
 * a session bundle with skills, in-memory connections, and a session context
 * that holds them.
 */

import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { buildStepCatalog } from "#execution/catalog/step-catalog.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import {
  type ConnectionClient,
  type ConnectionToolMetadata,
  defineInteractiveAuthorization,
} from "#shared/connection-types.js";
import type { JsonObject } from "#shared/json.js";
import { toInputSchema } from "#tools/schema.js";

const OBJECT_SCHEMA: JsonObject = { type: "object", additionalProperties: false };

/** A tool with an inline `execute` that echoes its name and input. */
export function inlineTool(
  name: string,
  overrides: Partial<HarnessToolDefinition> & { readonly schema?: JsonObject } = {},
): HarnessToolDefinition {
  const { schema = OBJECT_SCHEMA, ...rest } = overrides;
  return {
    description: `${name} description`,
    execute: async (input: unknown) => ({ ran: name, input }),
    inputSchema: toInputSchema(schema),
    name,
    ...rest,
  };
}

/** A workflow tool; `task` runs each call as a background task. */
export function workflowTool(
  name: string,
  entryPoint: "execute" | "task" = "execute",
  overrides: Partial<HarnessToolDefinition> = {},
): HarnessToolDefinition {
  const workflowId = `workflow//./agent/tools/${name}//${entryPoint}`;
  return {
    behavior: {
      availability: [],
      handling: {
        kind: "dispatch",
        target: { entryPoint, kind: "workflow-tool-call", workflowId },
      },
    },
    description: `${name} description`,
    inputSchema: toInputSchema({ type: "object" }),
    name,
    workflowId,
    ...overrides,
  };
}

/** A declared subagent; every call to it starts a child session. */
export function subagentTool(
  name: string,
  overrides: Partial<HarnessToolDefinition> = {},
): HarnessToolDefinition {
  return {
    behavior: {
      availability: [],
      handling: {
        kind: "dispatch",
        target: { kind: "subagent-call", nodeId: `subagents/${name}`, subagentName: name },
      },
    },
    description: `${name} description`,
    inputSchema: toInputSchema({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    }),
    name,
    workflowId: `workflow//./agent/subagents/${name}//execute`,
    ...overrides,
  };
}

export function toolMap(...tools: readonly HarnessToolDefinition[]) {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export interface CatalogSkillSource {
  readonly deferred?: boolean;
  readonly description?: string;
  readonly markdown?: string;
  readonly name: string;
}

/** The parts of a session bundle the catalog reads: authored skills and dynamic subagent resolvers. */
export function catalogBundle(
  input: {
    /** The connections the agent declares. */
    readonly connections?: readonly ResolvedConnectionDefinition[];
    readonly dynamicSubagents?: readonly string[];
    readonly skills?: readonly CatalogSkillSource[];
  } = {},
): CompiledBundle {
  return {
    adapterRegistry: undefined as never,
    compiledArtifactsSource: undefined as never,
    graph: undefined as never,
    hookRegistry: undefined as never,
    moduleMap: undefined as never,
    nodeId: undefined,
    resolvedAgent: {
      config: { name: "test-agent" },
      connections: input.connections ?? [],
      dynamicSkillResolvers: [],
      dynamicToolResolvers: [],
      skills: (input.skills ?? []).map((skill) => ({
        deferred: skill.deferred,
        description: skill.description ?? `${skill.name} skill`,
        markdown: skill.markdown ?? `# ${skill.name}`,
        name: skill.name,
      })),
    } as never,
    subagentRegistry: {
      dynamicResolvers: (input.dynamicSubagents ?? []).map((name) => ({ name })),
      preparedTools: [],
      subagentsByName: new Map(),
    } as never,
    toolRegistry: { toolsByName: new Map() } as never,
    turnAgent: undefined as never,
  };
}

/** How a fake connection answers a request to list its tools. */
export type ConnectionListing = "listed" | "sign-in" | Error;

export interface FakeConnection {
  /** Each tool call the connection received, in order. */
  readonly calls: { readonly input: unknown; readonly tool: string }[];
  readonly client: ConnectionClient;
  readonly definition: ResolvedConnectionDefinition;
  listing: ConnectionListing;
  /** Callback URLs of the interactive sign-ins it started, in order. */
  readonly signIns: string[];
}

/**
 * An in-memory connection. With `signIn`, it supports interactive sign-in and
 * lists its tools once a sign-in completes, unless it `rejectsToken`.
 */
export function fakeConnection(input: {
  readonly approval?: ResolvedConnectionDefinition["approval"];
  readonly description?: string;
  readonly listing?: ConnectionListing;
  readonly name: string;
  readonly rejectsToken?: boolean;
  readonly signIn?: boolean;
  readonly tools: readonly ConnectionToolMetadata[];
}): FakeConnection {
  const calls: FakeConnection["calls"] = [];
  const signIns: string[] = [];
  const definition: ResolvedConnectionDefinition = {
    approval: input.approval,
    connectionName: input.name,
    description: input.description ?? `${input.name} service`,
    logicalPath: `connections/${input.name}.ts`,
    protocol: "mcp",
    sourceId: `connections/${input.name}.ts`,
    sourceKind: "module",
    url: `https://${input.name}.example.com/mcp`,
  };
  const connection: FakeConnection = {
    calls,
    client: {
      close: async () => {},
      connect: async () => {},
      executeTool: async (tool, args) => {
        calls.push({ input: args, tool });
        return { content: [{ type: "text", text: JSON.stringify({ tool, args }) }] };
      },
      getToolMetadata: async () => {
        if (connection.listing === "sign-in") {
          throw new ConnectionAuthorizationRequiredError(input.name);
        }
        if (connection.listing instanceof Error) throw connection.listing;
        return input.tools;
      },
    },
    definition:
      input.signIn === true
        ? {
            ...definition,
            authorization: defineInteractiveAuthorization({
              getToken: async () => {
                throw new ConnectionAuthorizationRequiredError(input.name);
              },
              startAuthorization: async ({ callbackUrl }) => {
                signIns.push(callbackUrl);
                return {
                  challenge: { url: `https://idp.example.com/authorize?redirect=${callbackUrl}` },
                };
              },
              completeAuthorization: async () => {
                if (input.rejectsToken !== true) connection.listing = "listed";
                return { token: `${input.name}-token` };
              },
            }),
          }
        : definition,
    listing: input.listing ?? "listed",
    signIns,
  };
  return connection;
}

/** A registry over `connections`; the array may change to model dynamic connections. */
export function connectionRegistry(connections: readonly FakeConnection[]): ConnectionRegistry {
  const find = (name: string) => {
    const connection = connections.find((entry) => entry.definition.connectionName === name);
    if (connection === undefined) throw new Error(`No connection named "${name}".`);
    return connection;
  };
  return {
    dispose: async () => {},
    getClient: (name) => find(name).client,
    getConnectionApproval: (name) => find(name).definition.approval,
    getConnectionNames: () => connections.map((entry) => entry.definition.connectionName),
    getConnections: () => connections.map((entry) => entry.definition),
  };
}

/** Connection tool metadata with a JSON Schema input. */
export function connectionTool(
  name: string,
  inputSchema: JsonObject = { type: "object", properties: {} },
  description = `${name} description`,
): ConnectionToolMetadata {
  return { description, inputSchema, name };
}

/**
 * Alice's session with `tools`, `skills`, and `connections`, and the step
 * catalog built from it. `run` runs code inside the session's context.
 */
export function catalogContext(
  input: {
    readonly connections?: readonly FakeConnection[];
    readonly dynamicSubagents?: readonly string[];
    readonly session?: { readonly rootSessionId?: string };
    readonly skills?: readonly CatalogSkillSource[];
    readonly tools?: readonly HarnessToolDefinition[];
  } = {},
) {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, {
    attributes: {},
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
  });
  ctx.set(SessionIdKey, "catalog-session");
  ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
  ctx.set(
    BundleKey,
    catalogBundle({
      connections: input.connections?.map((connection) => connection.definition),
      dynamicSubagents: input.dynamicSubagents,
      skills: input.skills,
    }),
  );
  if (input.connections !== undefined) {
    ctx.set(ConnectionRegistryKey, connectionRegistry(input.connections));
  }
  const catalog = buildStepCatalog({
    agentTools: toolMap(...(input.tools ?? [])),
    ctx,
    endsTurn: true,
    session: input.session ?? {},
  });
  return { catalog, ctx, run: <T>(fn: () => T) => contextStorage.run(ctx, fn) };
}

/** Names in eve's namespace, which nothing authored or dynamic may take. */
export const EVE_NAMESPACE_NAMES = ["eve", "eve__search", "eve__anything"];

/**
 * Names outside eve's namespace: the built-in tools' former names, which are
 * free again, and names that only contain "eve".
 */
export const NAMES_OUTSIDE_EVE_NAMESPACE = [
  "search",
  "execute",
  "task_wait",
  "task_cancel",
  "final_output",
  "steve",
  "eve_tool",
  "my__eve__x",
];

/** How every reserved-name error explains the rule. */
export const EVE_NAMESPACE_RESERVATION = 'eve reserves the "eve" namespace for its built-in tools';
