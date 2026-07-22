import { describe, expect, it } from "vitest";

import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { CallbackBaseUrlKey, isAuthorizationSignal } from "#harness/authorization.js";
import { ConnectionAuthorizationRequiredError } from "#public/connections/errors.js";
import type { ToolContext } from "#public/definitions/tool.js";
import type { ConnectionRegistry, ConnectionToolMetadata } from "#runtime/connections/types.js";
import {
  createConnectionSearchEvents,
  extractDiscoveredTools,
} from "#runtime/framework-tools/connection-search-dynamic.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { DynamicResolveContext, DynamicToolSet } from "#shared/dynamic-tool-definition.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any;

function connection(name: string): ResolvedConnectionDefinition {
  return {
    connectionName: name,
    description: `${name} connection`,
    logicalPath: `agent/connections/${name}.ts`,
    protocol: "mcp",
    sourceId: `connections/${name}`,
    sourceKind: "module",
    url: `https://${name}.example.com/mcp`,
  };
}

async function executeConnectionSearch(
  registry: ConnectionRegistry,
  input: { readonly connection?: string; readonly keywords: string; readonly limit?: number },
  setupContext?: (ctx: ContextContainer) => void,
): Promise<unknown> {
  const ctx = new ContextContainer();
  ctx.set(ConnectionRegistryKey, registry);
  setupContext?.(ctx);

  return contextStorage.run(ctx, async () => {
    const resolve = createConnectionSearchEvents()["step.started"]!;
    const resolved = (await resolve({}, {
      channel: {},
      messages: [],
      session: { auth: { current: null, initiator: null }, id: "test-session" },
    } satisfies DynamicResolveContext)) as DynamicToolSet;

    return resolved["connection_search"]!.execute(input, {} as ToolContext);
  });
}

function registry(input: {
  readonly connections: readonly ResolvedConnectionDefinition[];
  readonly loadTools: Readonly<Record<string, () => Promise<readonly ConnectionToolMetadata[]>>>;
}): ConnectionRegistry {
  return {
    dispose: async () => {},
    getClient: (name) => ({
      close: async () => {},
      connect: async () => {},
      executeTool: async () => {},
      getToolMetadata: input.loadTools[name]!,
      getTools: async () => ({}),
    }),
    getConnectionApproval: () => undefined,
    getConnectionNames: () => input.connections.map((item) => item.connectionName),
    getConnections: () => input.connections,
  };
}

describe("connection_search", () => {
  it("fails when every targeted connection fails to load", async () => {
    const incident = connection("incident");
    const connectionRegistry = registry({
      connections: [incident],
      loadTools: {
        incident: async () => {
          throw new Error("MCP SSE Transport Error: 400 Bad Request");
        },
      },
    });

    await expect(
      executeConnectionSearch(connectionRegistry, {
        connection: "incident",
        keywords: "list incidents",
      }),
    ).rejects.toThrow(
      'Failed to load tools for "incident": MCP SSE Transport Error: 400 Bad Request',
    );
  });

  it("fails when the requested connection is not registered", async () => {
    const incident = connection("incident");
    const connectionRegistry = registry({
      connections: [incident],
      loadTools: { incident: async () => [] },
    });

    await expect(
      executeConnectionSearch(connectionRegistry, {
        connection: "incidents",
        keywords: "list incidents",
      }),
    ).rejects.toThrow('Connection "incidents" is not registered. Available connections: incident.');
  });

  it("fails when authorization cannot be started", async () => {
    const salesforce: ResolvedConnectionDefinition = {
      ...connection("salesforce"),
      authorization: {
        completeAuthorization: async () => ({ token: "unused" }),
        getToken: async () => {
          throw new ConnectionAuthorizationRequiredError("salesforce");
        },
        principalType: "user",
        startAuthorization: async () => {
          throw new Error("OAuth provider unavailable");
        },
      },
    };
    const connectionRegistry = registry({
      connections: [salesforce],
      loadTools: {
        salesforce: async () => {
          throw new ConnectionAuthorizationRequiredError("salesforce");
        },
      },
    });

    await expect(
      executeConnectionSearch(
        connectionRegistry,
        { connection: "salesforce", keywords: "accounts" },
        (ctx) => {
          ctx.set(SessionIdKey, "session-auth");
          ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
          ctx.set(AuthKey, {
            attributes: {},
            authenticator: "test-idp",
            issuer: "test-idp",
            principalId: "user-1",
            principalType: "user",
          });
        },
      ),
    ).rejects.toThrow('Failed to start authorization for "salesforce": OAuth provider unavailable');
  });

  it("returns connection summaries when loading succeeds without a keyword match", async () => {
    const incident = connection("incident");
    const connectionRegistry = registry({
      connections: [incident],
      loadTools: { incident: async () => [] },
    });

    await expect(
      executeConnectionSearch(connectionRegistry, { keywords: "list incidents" }),
    ).resolves.toEqual([
      {
        connection: "incident",
        description: "incident connection",
      },
    ]);
  });

  it("returns matches and errors when at least one connection loads", async () => {
    const incident = connection("incident");
    const linear = connection("linear");
    const connectionRegistry = registry({
      connections: [incident, linear],
      loadTools: {
        incident: async () => {
          throw new Error("MCP SSE Transport Error: 400 Bad Request");
        },
        linear: async () => [
          {
            description: "List issues",
            inputSchema: { type: "object" },
            name: "list_issues",
          },
        ],
      },
    });

    await expect(
      executeConnectionSearch(connectionRegistry, { keywords: "list issues" }),
    ).resolves.toEqual([
      {
        connection: "linear",
        description: "List issues",
        inputSchema: { type: "object" },
        outputSchema: undefined,
        qualifiedName: "linear__list_issues",
        tool: "list_issues",
      },
      {
        connection: "incident",
        description: "incident connection",
        error: 'Failed to load tools for "incident": MCP SSE Transport Error: 400 Bad Request',
      },
    ]);
  });

  it("returns an authorization signal when sign-in can be started", async () => {
    const salesforce: ResolvedConnectionDefinition = {
      ...connection("salesforce"),
      authorization: {
        completeAuthorization: async () => ({ token: "unused" }),
        getToken: async () => {
          throw new ConnectionAuthorizationRequiredError("salesforce");
        },
        principalType: "user",
        startAuthorization: async () => ({
          challenge: { url: "https://idp.example.com/authorize" },
        }),
      },
    };
    const connectionRegistry = registry({
      connections: [salesforce],
      loadTools: {
        salesforce: async () => {
          throw new ConnectionAuthorizationRequiredError("salesforce");
        },
      },
    });

    const result = await executeConnectionSearch(
      connectionRegistry,
      { connection: "salesforce", keywords: "accounts" },
      (ctx) => {
        ctx.set(SessionIdKey, "session-auth");
        ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
        ctx.set(AuthKey, {
          attributes: {},
          authenticator: "test-idp",
          issuer: "test-idp",
          principalId: "user-1",
          principalType: "user",
        });
      },
    );

    expect(isAuthorizationSignal(result)).toBe(true);
    if (!isAuthorizationSignal(result)) throw new Error("expected authorization signal");
    expect(result.challenges).toMatchObject([
      {
        name: "salesforce",
        challenge: { url: "https://idp.example.com/authorize" },
      },
    ]);
  });
});

describe("extractDiscoveredTools", () => {
  it("extracts tools from raw array output", () => {
    const messages: Msg[] = [
      { role: "user", content: [{ type: "text", text: "search" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "connection_search",
            output: [
              {
                connection: "linear",
                tool: "list_issues",
                qualifiedName: "linear__list_issues",
                description: "List issues",
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
              },
            ],
          },
        ],
      },
    ];

    const result = extractDiscoveredTools(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.qualifiedName).toBe("linear__list_issues");
    expect(result[0]!.connection).toBe("linear");
    expect(result[0]!.tool).toBe("list_issues");
    expect(result[0]!.outputSchema).toEqual({ type: "object" });
  });

  it("extracts tools from ToolResultOutput json wrapper", () => {
    const messages: Msg[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "connection_search",
            output: {
              type: "json",
              value: [
                {
                  connection: "linear",
                  tool: "list_issues",
                  qualifiedName: "linear__list_issues",
                  description: "List issues",
                  inputSchema: { type: "object" },
                },
              ],
            },
          },
        ],
      },
    ];

    const result = extractDiscoveredTools(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.qualifiedName).toBe("linear__list_issues");
  });

  it("returns empty for no tool results", () => {
    const messages: Msg[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    expect(extractDiscoveredTools(messages)).toHaveLength(0);
  });

  it("deduplicates by qualifiedName (latest wins)", () => {
    const messages: Msg[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "connection_search",
            output: [
              {
                connection: "linear",
                tool: "list_issues",
                qualifiedName: "linear__list_issues",
                description: "Old description",
              },
            ],
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "connection_search",
            output: [
              {
                connection: "linear",
                tool: "list_issues",
                qualifiedName: "linear__list_issues",
                description: "New description",
              },
            ],
          },
        ],
      },
    ];

    const result = extractDiscoveredTools(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("New description");
  });

  it("skips items without tool or qualifiedName", () => {
    const messages: Msg[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "connection_search",
            output: [
              {
                connection: "linear",
                description: "No tool or qualifiedName",
              },
              {
                connection: "linear",
                tool: "list_issues",
                qualifiedName: "linear__list_issues",
                description: "Valid",
              },
            ],
          },
        ],
      },
    ];

    const result = extractDiscoveredTools(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("Valid");
  });
});
