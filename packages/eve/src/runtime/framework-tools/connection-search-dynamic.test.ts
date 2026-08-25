import { describe, expect, it } from "vitest";

import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import {
  CallbackBaseUrlKey,
  isAuthorizationSignal,
  PendingAuthorizationResultKey,
} from "#harness/authorization.js";
import { ConnectionAuthorizationRequiredError } from "#public/connections/errors.js";
import type { ToolContext } from "#public/definitions/tool.js";
import type { ConnectionRegistry, ConnectionToolMetadata } from "#runtime/connections/types.js";
import connectionSearchDynamicDefinition from "#runtime/framework-tools/connection-search-dynamic.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import {
  isBrandedToolEntry,
  type DynamicResolveContext,
  type DynamicToolSet,
} from "#shared/dynamic-tool-definition.js";
import { readDurableDynamicToolCallbacks } from "#shared/durable-dynamic-tool-callbacks.js";

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

function resolveContext(sessionId = "test-session"): DynamicResolveContext {
  return {
    channel: {},
    messages: [],
    session: { auth: { current: null, initiator: null }, id: sessionId },
  };
}

function getConnectionSearchResolve() {
  return connectionSearchDynamicDefinition.events["step.started"]!;
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
    const resolve = getConnectionSearchResolve();
    const resolved = (await resolve({}, resolveContext())) as DynamicToolSet;

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

describe("connection dynamic tools", () => {
  it("resolves at step.started only", () => {
    expect(Object.keys(connectionSearchDynamicDefinition.events)).toEqual(["step.started"]);
  });

  it("contributes no tools when no connections are available", async () => {
    const ctx = new ContextContainer();
    ctx.set(
      ConnectionRegistryKey,
      registry({
        connections: [],
        loadTools: {},
      }),
    );
    const resolve = getConnectionSearchResolve();

    const tools = await contextStorage.run(ctx, () => resolve({}, resolveContext()));

    expect(tools).toBeNull();
  });

  it("re-derives discovered tools from the durable connection-search results", async () => {
    const linear = connection("linear");
    const connectionRegistry = registry({
      connections: [linear],
      loadTools: {
        linear: async () => [
          {
            description: "List issues",
            inputSchema: { type: "object" },
            name: "list_issues",
          },
        ],
      },
    });
    const ctx = new ContextContainer();
    ctx.set(ConnectionRegistryKey, connectionRegistry);
    const resolve = getConnectionSearchResolve();

    const tools = await contextStorage.run(ctx, async () => {
      const initial = (await resolve({}, resolveContext())) as DynamicToolSet;
      expect(Object.keys(initial)).toEqual(["connection_search"]);

      // A successful search records its matches on the durable results key —
      // the sole source of discovered tools (history is never rescanned).
      await initial["connection_search"]!.execute({ keywords: "list issues" }, {} as ToolContext);

      return (await resolve({}, resolveContext())) as DynamicToolSet;
    });

    expect(Object.keys(tools)).toEqual(["connection_search", "linear__list_issues"]);
    expect(Object.values(tools).every(isBrandedToolEntry)).toBe(true);
  });
});

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

  it("does not complete an unrelated connection authorization", async () => {
    let notionCompletions = 0;
    const notion: ResolvedConnectionDefinition = {
      ...connection("notion"),
      authorization: {
        completeAuthorization: async () => {
          notionCompletions += 1;
          throw new Error("stale Notion callback");
        },
        getToken: async () => ({ token: "notion-token" }),
        principalType: "user",
        startAuthorization: async () => ({
          challenge: { url: "https://idp.example.com/authorize" },
        }),
      },
    };
    const linear = connection("linear");
    const connectionRegistry = registry({
      connections: [notion, linear],
      loadTools: {
        notion: async () => [],
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
      executeConnectionSearch(
        connectionRegistry,
        { connection: "linear", keywords: "list issues" },
        (ctx) => {
          ctx.set(PendingAuthorizationResultKey, [
            {
              attemptId: "attempt-notion",
              callback: { method: "GET", params: {} },
              hookUrl: "https://agent.example.com/eve/v1/connections/notion/callback/auth",
              name: "notion",
              principal: { type: "app" },
            },
          ]);
        },
      ),
    ).resolves.toMatchObject([
      {
        connection: "linear",
        qualifiedName: "linear__list_issues",
      },
    ]);
    expect(notionCompletions).toBe(0);
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

  it("replays authorization from the step-scoped durable execute descriptor", async () => {
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
    const ctx = new ContextContainer();
    ctx.set(ConnectionRegistryKey, connectionRegistry);
    ctx.set(SessionIdKey, "session-auth-replay");
    ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
    ctx.set(AuthKey, {
      attributes: {},
      authenticator: "test-idp",
      issuer: "test-idp",
      principalId: "user-1",
      principalType: "user",
    });

    const result = await contextStorage.run(ctx, async () => {
      const resolve = getConnectionSearchResolve();
      const tools = (await resolve({}, resolveContext("session-auth-replay"))) as DynamicToolSet;
      const reference = readDurableDynamicToolCallbacks(tools["connection_search"]!)!.execute!;

      return await reference.callback(reference.closure, {
        connection: "salesforce",
        keywords: "accounts",
      } as never);
    });

    expect(isAuthorizationSignal(result)).toBe(true);
  });
});
