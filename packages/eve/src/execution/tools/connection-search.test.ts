import { describe, expect, it, vi } from "vitest";

import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import {
  CallbackBaseUrlKey,
  isAuthorizationSignal,
  PendingAuthorizationResultKey,
} from "#harness/authorization.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import type { ToolContext } from "#tools/definition.js";
import type {
  ConnectionToolExecuteOptions,
  ConnectionToolMetadata,
} from "#shared/connection-types.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import connectionSearch from "#tools/framework/connection-search.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { isBrandedToolEntry, type DynamicToolSet } from "#tools/dynamic.js";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import { readDurableDynamicToolCallbacks } from "#tools/durable-callbacks.js";
import { resolveHeaders } from "#runtime/connections/mcp-client.js";

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
    const resolve = getConnectionSearchResolver().events["step.started"]!;
    const resolved = (await resolve({}, {
      channel: {},
      messages: [],
      session: { auth: { current: null, initiator: null }, id: "test-session" },
    } satisfies DynamicResolveContext)) as DynamicToolSet;

    return resolved["connection_search"]!.execute(input, {} as ToolContext);
  });
}

function getConnectionSearchResolver() {
  return connectionSearch;
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
  it("contributes no tools when no connections are available", async () => {
    const ctx = new ContextContainer();
    ctx.set(
      ConnectionRegistryKey,
      registry({
        connections: [],
        loadTools: {},
      }),
    );
    const resolve = getConnectionSearchResolver().events["step.started"]!;

    const tools = await contextStorage.run(ctx, () =>
      resolve(
        {},
        {
          channel: {},
          messages: [],
          session: { auth: { current: null, initiator: null }, id: "test-session" },
        },
      ),
    );

    expect(tools).toBeNull();
  });

  it("uses the shared resolver and public tool definitions", async () => {
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
    const resolver = getConnectionSearchResolver();
    const resolve = resolver.events["step.started"]!;

    const tools = await contextStorage.run(ctx, async () => {
      const initial = (await resolve(
        {},
        {
          channel: {},
          messages: [],
          session: { auth: { current: null, initiator: null }, id: "test-session" },
        },
      )) as DynamicToolSet;
      await initial["connection_search"]!.execute({ keywords: "list issues" }, {} as ToolContext);
      return (await resolve(
        {},
        {
          channel: {},
          messages: [],
          session: { auth: { current: null, initiator: null }, id: "test-session" },
        },
      )) as DynamicToolSet;
    });

    expect(Object.keys(tools)).toEqual(["connection_search", "linear__list_issues"]);
    expect(Object.values(tools).every(isBrandedToolEntry)).toBe(true);
  });

  it("forwards the authored tool call ID to connection execution", async () => {
    const linear = connection("linear");
    const executeTool = vi.fn(
      async (_toolName: string, _args: unknown, _options?: ConnectionToolExecuteOptions) => ({
        ok: true,
      }),
    );
    const baseRegistry = registry({
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
    const connectionRegistry: ConnectionRegistry = {
      ...baseRegistry,
      getClient: (name) => ({
        ...baseRegistry.getClient(name),
        executeTool,
      }),
    };
    const ctx = new ContextContainer();
    ctx.set(ConnectionRegistryKey, connectionRegistry);
    const abortSignal = {} as AbortSignal;

    await contextStorage.run(ctx, async () => {
      const resolve = getConnectionSearchResolver().events["step.started"]!;
      const resolveContext = {
        channel: {},
        messages: [],
        session: { auth: { current: null, initiator: null }, id: "test-session" },
      } satisfies DynamicResolveContext;
      const initial = (await resolve({}, resolveContext)) as DynamicToolSet;
      await initial["connection_search"]!.execute({ keywords: "list issues" }, {} as ToolContext);
      const tools = (await resolve({}, resolveContext)) as DynamicToolSet;

      for (const callId of ["call-1", "call-2", "call-1"]) {
        await tools["linear__list_issues"]!.execute({}, { abortSignal, callId } as ToolContext);
      }
    });

    expect(executeTool.mock.calls.map(([, , options]) => options?.callId)).toEqual([
      "call-1",
      "call-2",
      "call-1",
    ]);
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

  it("does not pass a parked callback to a newly resolved connection instance", async () => {
    const completeAuthorization = vi.fn(async () => ({ token: "instance-b-token" }));
    const salesforce: ResolvedConnectionDefinition = {
      ...connection("salesforce"),
      authorization: {
        completeAuthorization,
        getToken: async () => ({ token: "instance-b-token" }),
        principalType: "user",
        startAuthorization: async () => ({ challenge: {} }),
      },
      instanceId: "instance-b",
    };
    const connectionRegistry = registry({
      connections: [salesforce],
      loadTools: { salesforce: async () => [] },
    });

    await expect(
      executeConnectionSearch(
        connectionRegistry,
        { connection: "salesforce", keywords: "accounts" },
        (ctx) => {
          ctx.set(PendingAuthorizationResultKey, [
            {
              attemptId: "attempt-a",
              callback: { method: "GET", params: { code: "code-a" } },
              hookUrl: "https://agent.example.com/callback",
              instanceId: "instance-a",
              name: "salesforce",
              principal: { id: "user-1", issuer: "test-idp", type: "user" },
            },
          ]);
        },
      ),
    ).rejects.toThrow("resolved connection changed while sign-in was pending");
    expect(completeAuthorization).not.toHaveBeenCalled();
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
      instanceId: "salesforce-instance",
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
        instanceId: "salesforce-instance",
      },
    ]);
  });

  it.each([false, true])(
    "completes connection auth through the shared token cache (fresh token refused: %s)",
    async (refused) => {
      const getToken = vi.fn(async () => {
        throw new ConnectionAuthorizationRequiredError("salesforce");
      });
      const startAuthorization = vi.fn(async () => ({
        challenge: { url: "https://idp.example.com/authorize" },
      }));
      const completeAuthorization = vi.fn(async () => ({ token: "fresh-token" }));
      const salesforce: ResolvedConnectionDefinition = {
        ...connection("salesforce"),
        instanceId: "salesforce-instance",
        authorization: {
          principalType: "user",
          getToken,
          startAuthorization,
          completeAuthorization,
        },
      };
      const connectionRegistry = registry({
        connections: [salesforce],
        loadTools: {
          salesforce: async () => {
            const headers = await resolveHeaders(salesforce);
            expect(headers.Authorization).toBe("Bearer fresh-token");
            if (refused) throw new ConnectionAuthorizationRequiredError("salesforce");
            return [{ name: "list_accounts", description: "List accounts", inputSchema: {} }];
          },
        },
      });
      const setup = (ctx: ContextContainer) => {
        ctx.set(SessionIdKey, "session-auth");
        ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
        ctx.set(AuthKey, {
          attributes: {},
          authenticator: "test-idp",
          issuer: "test-idp",
          principalId: "user-1",
          principalType: "user",
        });
      };
      const input = { connection: "salesforce", keywords: "accounts" };
      const pending = await executeConnectionSearch(connectionRegistry, input, setup);
      if (!isAuthorizationSignal(pending)) throw new Error("expected authorization signal");
      const challenge = pending.challenges[0]!;
      expect(challenge).toMatchObject({
        instanceId: "salesforce-instance",
        principal: { type: "user", id: "user-1", issuer: "test-idp" },
      });
      const resumed = executeConnectionSearch(connectionRegistry, input, (ctx) => {
        setup(ctx);
        ctx.set(PendingAuthorizationResultKey, [
          {
            ...challenge,
            callback: { method: "GET", params: { code: "approved" } },
          },
        ]);
      });
      if (refused) {
        await expect(resumed).rejects.toThrow("rejected the token immediately after authorization");
      } else {
        await expect(resumed).resolves.toMatchObject([
          { qualifiedName: "salesforce__list_accounts" },
        ]);
      }
      expect(getToken).toHaveBeenCalledOnce();
      expect(startAuthorization).toHaveBeenCalledOnce();
      expect(completeAuthorization).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          principal: challenge.principal,
          callback: { method: "GET", params: { code: "approved" } },
        }),
      );
    },
  );

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
      const resolve = getConnectionSearchResolver().events["step.started"]!;
      const tools = (await resolve({}, {
        channel: {},
        messages: [],
        session: { auth: { current: null, initiator: null }, id: "session-auth-replay" },
      } satisfies DynamicResolveContext)) as DynamicToolSet;
      const reference = readDurableDynamicToolCallbacks(tools["connection_search"]!)!.execute!;

      return await reference.callback(reference.closure, {
        connection: "salesforce",
        keywords: "accounts",
      } as never);
    });

    expect(isAuthorizationSignal(result)).toBe(true);
  });
});
