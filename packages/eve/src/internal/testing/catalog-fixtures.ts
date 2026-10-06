/**
 * Building blocks for tests of the step catalog: agent entries of each kind,
 * a session bundle with skills, and in-memory connections.
 */

import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
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
 * lists its tools once a sign-in completes.
 */
export function fakeConnection(input: {
  readonly approval?: ResolvedConnectionDefinition["approval"];
  readonly description?: string;
  readonly listing?: ConnectionListing;
  readonly name: string;
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
                connection.listing = "listed";
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
