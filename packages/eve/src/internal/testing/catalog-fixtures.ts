import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { stepCatalog } from "#definitions/step.js";
import type { HarnessToolMap } from "#harness/types.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ApprovalPolicy } from "#approval/definition.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { type CompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import {
  type ConnectionClient,
  type ConnectionToolMetadata,
  defineInteractiveAuthorization,
} from "#shared/connection-types.js";
import type { JsonObject } from "#shared/json.js";
import { toInputSchema } from "#tools/schema.js";

const OBJECT_SCHEMA: JsonObject = { type: "object", additionalProperties: false };

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

export function catalogBundle(
  input: {
    readonly approval?: ApprovalPolicy;
    readonly channels?: readonly unknown[];
    readonly connections?: readonly ResolvedConnectionDefinition[];
    readonly dynamicSubagents?: readonly string[];
    readonly skills?: readonly CatalogSkillSource[];
  } = {},
): CompiledBundle {
  return {
    adapterRegistry: undefined as never,
    compiledArtifactsSource: undefined as never,
    graph: {
      nodesByNodeId: new Map([
        [ROOT_RUNTIME_AGENT_NODE_ID, { agent: { config: { approval: input.approval } } }],
      ]),
    } as never,
    modelMetadata: undefined as never,
    moduleMap: undefined as never,
    nodeId: undefined,
    resolvedAgent: {
      channels: input.channels ?? [],
      config: { approval: input.approval, name: "test-agent" },
      connections: input.connections ?? [],
      definitions: [],
      instructions: [],
      skills: (input.skills ?? []).map((skill) => ({
        deferred: skill.deferred,
        description: skill.description ?? `${skill.name} skill`,
        content: skill.markdown ?? `# ${skill.name}`,
        name: skill.name,
      })),
    } as never,
    subagentRegistry: {
      dynamicResolvers: (input.dynamicSubagents ?? []).map((name) => ({ name })),
      preparedTools: [],
      subagentsByName: new Map(),
    } as never,
    toolRegistry: { toolsByName: new Map() } as never,
    turnAgent: { tools: [] } as never,
  };
}

export type ConnectionListing = "listed" | "sign-in" | Error;

export interface FakeConnection {
  readonly calls: { readonly input: unknown; readonly tool: string }[];
  readonly client: ConnectionClient;
  readonly eventCalls: { readonly input: unknown; readonly name: string }[];
  readonly eventListCalls: number[];
  readonly definition: ResolvedConnectionDefinition;
  listing: ConnectionListing;
  readonly signIns: string[];
}

export function fakeConnection(input: {
  readonly approval?: ResolvedConnectionDefinition["approval"];
  readonly description?: string;
  readonly events?: readonly string[];
  readonly listing?: ConnectionListing;
  readonly name: string;
  readonly rejectsToken?: boolean;
  readonly signIn?: boolean;
  readonly toolCall?: ResolvedConnectionDefinition["toolCall"];
  readonly tools: readonly ConnectionToolMetadata[];
}): FakeConnection {
  const calls: FakeConnection["calls"] = [];
  const eventCalls: FakeConnection["eventCalls"] = [];
  const eventListCalls: number[] = [];
  const signIns: string[] = [];
  const eventDefinitions = (input.events ?? []).map((event) => ({
    description: `Watch ${event}.`,
    inputSchema: { type: "object" },
    name: event,
  }));
  const definition: ResolvedConnectionDefinition = {
    approval: input.approval,
    connectionName: input.name,
    description: input.description ?? `${input.name} service`,
    logicalPath: `connections/${input.name}.ts`,
    protocol: "mcp",
    sourceId: `connections/${input.name}.ts`,
    sourceKind: "module",
    toolCall: input.toolCall,
    url: `https://${input.name}.example.com/mcp`,
    ...(input.events !== undefined && { experimental_events: {} as never }),
  };
  const connection: FakeConnection = {
    calls,
    eventCalls,
    eventListCalls,
    client: {
      close: async () => {},
      connect: async () => {},
      ...(input.events !== undefined && {
        eventActions: {
          execute: async (name: string, args: unknown) => {
            eventCalls.push({ input: args, name });
            return { id: "subscription-1", status: "active" };
          },
          list: async () => {
            eventListCalls.push(eventListCalls.length + 1);
            return eventDefinitions;
          },
        },
      }),
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

export function connectionTool(
  name: string,
  inputSchema: JsonObject = { type: "object", properties: {} },
  description = `${name} description`,
): ConnectionToolMetadata {
  return { description, inputSchema, name };
}

export async function catalogContext(
  input: {
    readonly approval?: ApprovalPolicy;
    readonly channels?: readonly unknown[];
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
    SessionAgentKey,
    fromCompiledBundle(
      catalogBundle({
        approval: input.approval,
        channels: input.channels,
        connections: input.connections?.map((connection) => connection.definition),
        dynamicSubagents: input.dynamicSubagents,
        skills: input.skills,
      }),
    ),
  );
  if (input.connections !== undefined) {
    ctx.set(ConnectionRegistryKey, connectionRegistry(input.connections));
  }
  const catalog = await nativeCatalog({
    agentTools: toolMap(...(input.tools ?? [])),
    ctx,
    endsTurn: true,
    session: input.session ?? {},
  });
  return { catalog, ctx, run: <T>(fn: () => T) => contextStorage.run(ctx, fn) };
}

export const EVE_NAMESPACE_NAMES = ["eve", "eve__search", "eve__anything"];

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

export const EVE_NAMESPACE_RESERVATION = 'eve reserves the "eve" namespace for its built-in tools';

export async function nativeCatalog(input: {
  readonly agentTools: HarnessToolMap;
  readonly ctx: ContextContainer;
  readonly endsTurn: boolean;
  readonly session: { readonly rootSessionId?: string };
}): Promise<StepCatalog> {
  return await stepCatalog({
    config: { tools: input.agentTools },
    ctx: input.ctx,
    endsTurn: input.endsTurn,
    finalReplyOnly: false,
    session: input.session,
  });
}
