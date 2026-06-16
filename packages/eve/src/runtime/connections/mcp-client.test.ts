import { beforeEach, describe, expect, it, vi } from "vitest";

import { contextStorage, ContextContainer } from "#context/container.js";
import { AuthKey, type SessionAuthContext } from "#context/keys.js";
import {
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#public/connections/errors.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { ConnectionAuthorizationTokensKey } from "#runtime/connections/authorization-tokens.js";
import {
  isMcpAuthRequiredError,
  McpConnectionClient,
  passesToolFilter,
  resolveHeaders,
} from "#runtime/connections/mcp-client.js";

const { createMCPClient } = vi.hoisted(() => ({
  createMCPClient: vi.fn(),
}));

vi.mock("#compiled/@ai-sdk/mcp/index.js", () => ({
  createMCPClient,
}));

function ctxWithAuth(current: SessionAuthContext | null): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, current);
  return ctx;
}

function userAuth(id: string, issuer = "idp"): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "jwt-hmac",
    issuer,
    principalId: id,
    principalType: "user",
  };
}

function staticToken(token: string) {
  return {
    getToken: async () => ({ token }),
    principalType: "app" as const,
  };
}

function makeConnection(
  overrides: Partial<ResolvedConnectionDefinition> = {},
): ResolvedConnectionDefinition {
  return {
    authorization: staticToken("test-token"),
    connectionName: "test",
    description: "test connection",
    logicalPath: "connections/test.ts",
    protocol: "mcp",
    sourceId: "connections/test",
    sourceKind: "module",
    url: "https://mcp.example.com",
    ...overrides,
  };
}

describe("McpConnectionClient", () => {
  beforeEach(() => {
    createMCPClient.mockReset();
  });

  it("creates an HTTP MCP client with resolved connection headers", async () => {
    const client = {
      close: vi.fn(),
      listTools: vi.fn(),
      toolsFromDefinitions: vi.fn(),
    };
    createMCPClient.mockResolvedValue(client);

    const connection = makeConnection({
      headers: { "X-Api-Key": "key123" },
    });

    const mcpClient = new McpConnectionClient(connection);

    await expect(mcpClient.connect()).resolves.toBe(client);
    expect(createMCPClient).toHaveBeenCalledTimes(1);
    expect(createMCPClient).toHaveBeenCalledWith({
      transport: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Api-Key": "key123",
        },
        type: "http",
        url: "https://mcp.example.com",
      },
    });
  });

  it("falls back to SSE when HTTP transport is unsupported", async () => {
    const client = {
      close: vi.fn(),
      listTools: vi.fn(),
      toolsFromDefinitions: vi.fn(),
    };
    createMCPClient.mockRejectedValueOnce(
      new Error("MCP HTTP Transport Error: POSTing to endpoint (HTTP 404): not found"),
    );
    createMCPClient.mockResolvedValueOnce(client);

    const mcpClient = new McpConnectionClient(makeConnection());

    await expect(mcpClient.connect()).resolves.toBe(client);
    expect(createMCPClient).toHaveBeenNthCalledWith(1, {
      transport: {
        headers: { Authorization: "Bearer test-token" },
        type: "http",
        url: "https://mcp.example.com",
      },
    });
    expect(createMCPClient).toHaveBeenNthCalledWith(2, {
      transport: {
        headers: { Authorization: "Bearer test-token" },
        type: "sse",
        url: "https://mcp.example.com",
      },
    });
  });

  it("falls back to SSE when HTTP transport reports bad request", async () => {
    const client = {
      close: vi.fn(),
      listTools: vi.fn(),
      toolsFromDefinitions: vi.fn(),
    };
    createMCPClient.mockRejectedValueOnce(
      new Error("MCP HTTP Transport Error: POSTing to endpoint (HTTP 400): bad request"),
    );
    createMCPClient.mockResolvedValueOnce(client);

    const mcpClient = new McpConnectionClient(makeConnection());

    await expect(mcpClient.connect()).resolves.toBe(client);
    expect(createMCPClient).toHaveBeenCalledTimes(2);
    expect(createMCPClient).toHaveBeenNthCalledWith(2, {
      transport: {
        headers: { Authorization: "Bearer test-token" },
        type: "sse",
        url: "https://mcp.example.com",
      },
    });
  });

  it("falls back to SSE when HTTP transport reports method not allowed", async () => {
    const client = {
      close: vi.fn(),
      listTools: vi.fn(),
      toolsFromDefinitions: vi.fn(),
    };
    createMCPClient.mockRejectedValueOnce({ response: { status: 405 } });
    createMCPClient.mockResolvedValueOnce(client);

    const mcpClient = new McpConnectionClient(makeConnection());

    await expect(mcpClient.connect()).resolves.toBe(client);
    expect(createMCPClient).toHaveBeenCalledTimes(2);
    expect(createMCPClient).toHaveBeenNthCalledWith(2, {
      transport: {
        headers: { Authorization: "Bearer test-token" },
        type: "sse",
        url: "https://mcp.example.com",
      },
    });
  });

  it("falls back to SSE when HTTP transport reports bad request", async () => {
    const client = {
      close: vi.fn(),
      listTools: vi.fn(),
      toolsFromDefinitions: vi.fn(),
    };
    createMCPClient.mockRejectedValueOnce(
      new Error("MCP HTTP Transport Error: POSTing to endpoint (HTTP 400): bad request"),
    );
    createMCPClient.mockResolvedValueOnce(client);

    const mcpClient = new McpConnectionClient(makeConnection());

    await expect(mcpClient.connect()).resolves.toBe(client);
    expect(createMCPClient).toHaveBeenCalledTimes(2);
    expect(createMCPClient).toHaveBeenNthCalledWith(2, {
      transport: {
        headers: { Authorization: "Bearer test-token" },
        type: "sse",
        url: "https://mcp.example.com",
      },
    });
  });

  it("does not fall back to SSE for non-retryable HTTP client creation errors", async () => {
    const error = new Error(
      "MCP HTTP Transport Error: POSTing to endpoint (HTTP 401): unauthorized",
    );
    createMCPClient.mockRejectedValueOnce(error);

    const mcpClient = new McpConnectionClient(makeConnection());

    await expect(mcpClient.connect()).rejects.toBe(error);
    expect(createMCPClient).toHaveBeenCalledTimes(1);
    expect(createMCPClient).toHaveBeenCalledWith({
      transport: {
        headers: { Authorization: "Bearer test-token" },
        type: "http",
        url: "https://mcp.example.com",
      },
    });
  });
});

describe("isMcpAuthRequiredError", () => {
  it("treats a 401 invalid_token as authorization-required", () => {
    const error = Object.assign(
      new Error("MCP HTTP Transport Error: POSTing to endpoint (HTTP 401): invalid_token"),
      { statusCode: 401 },
    );
    expect(isMcpAuthRequiredError(error)).toBe(true);
  });

  it("detects a 401 from the message when no status field is present", () => {
    expect(isMcpAuthRequiredError(new Error("MCP HTTP Transport Error (HTTP 401): denied"))).toBe(
      true,
    );
  });

  it("detects a 401 nested on the cause chain", () => {
    expect(isMcpAuthRequiredError(new Error("wrapped", { cause: { statusCode: 401 } }))).toBe(true);
  });

  it("does not treat 403 / 500 / network errors as authorization-required", () => {
    expect(isMcpAuthRequiredError(Object.assign(new Error("x"), { statusCode: 403 }))).toBe(false);
    expect(isMcpAuthRequiredError(Object.assign(new Error("x"), { statusCode: 500 }))).toBe(false);
    expect(isMcpAuthRequiredError(new Error("ECONNRESET"))).toBe(false);
    expect(isMcpAuthRequiredError(undefined)).toBe(false);
  });
});

describe("McpConnectionClient authorization recovery", () => {
  beforeEach(() => {
    createMCPClient.mockReset();
  });

  function unauthorized() {
    return Object.assign(
      new Error(
        'MCP HTTP Transport Error: POSTing to endpoint (HTTP 401): {"error":"invalid_token"}',
      ),
      { statusCode: 401 },
    );
  }

  it("maps a 401 from listTools into ConnectionAuthorizationRequiredError", async () => {
    const client = {
      close: vi.fn(),
      listTools: vi.fn().mockRejectedValue(unauthorized()),
      toolsFromDefinitions: vi.fn(),
    };
    createMCPClient.mockResolvedValue(client);

    const mcpClient = new McpConnectionClient(makeConnection());
    const err = await mcpClient.getToolMetadata().catch((e) => e);

    expect(isConnectionAuthorizationRequiredError(err)).toBe(true);
  });

  it("maps a 401 from the transport (connect) into ConnectionAuthorizationRequiredError on load", async () => {
    createMCPClient.mockRejectedValue(unauthorized());

    const mcpClient = new McpConnectionClient(makeConnection());
    const err = await mcpClient.getToolMetadata().catch((e) => e);

    expect(isConnectionAuthorizationRequiredError(err)).toBe(true);
  });

  it("does not classify a 403 as authorization-required (propagates as-is)", async () => {
    const forbidden = Object.assign(new Error("HTTP 403 insufficient_scope"), { statusCode: 403 });
    const client = {
      close: vi.fn(),
      listTools: vi.fn().mockRejectedValue(forbidden),
      toolsFromDefinitions: vi.fn(),
    };
    createMCPClient.mockResolvedValue(client);

    const mcpClient = new McpConnectionClient(makeConnection());
    const err = await mcpClient.getToolMetadata().catch((e) => e);

    expect(isConnectionAuthorizationRequiredError(err)).toBe(false);
    expect(err).toBe(forbidden);
  });

  it("maps a 401 from executeTool into ConnectionAuthorizationRequiredError", async () => {
    const client = {
      close: vi.fn(),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: "do_thing", description: "", inputSchema: {} }],
      }),
      toolsFromDefinitions: vi.fn().mockReturnValue({
        do_thing: { execute: vi.fn().mockRejectedValue(unauthorized()) },
      }),
    };
    createMCPClient.mockResolvedValue(client);

    const mcpClient = new McpConnectionClient(makeConnection());
    const err = await mcpClient.executeTool("do_thing", {}).catch((e) => e);

    expect(isConnectionAuthorizationRequiredError(err)).toBe(true);
  });

  it("evicts the stale cached token when the server rejects it with 401", async () => {
    const client = {
      close: vi.fn(),
      listTools: vi.fn().mockRejectedValue(unauthorized()),
      toolsFromDefinitions: vi.fn(),
    };
    createMCPClient.mockResolvedValue(client);

    const connection = makeConnection({
      authorization: { getToken: async () => ({ token: "stale" }), principalType: "user" },
    });
    const mcpClient = new McpConnectionClient(connection);
    const ctx = ctxWithAuth(userAuth("alice"));

    await contextStorage.run(ctx, async () => {
      const err = await mcpClient.getToolMetadata().catch((e) => e);
      expect(isConnectionAuthorizationRequiredError(err)).toBe(true);
      // The bearer was cached during connect() and must be evicted on 401
      // so the re-authorization retry does not reuse the dead token.
      expect(ctx.get(ConnectionAuthorizationTokensKey)?.test).toEqual({});
    });
  });
});

describe("passesToolFilter", () => {
  it("passes all tools when filter is undefined", () => {
    expect(passesToolFilter("any_tool", undefined)).toBe(true);
  });

  it("passes tools in the allow list", () => {
    const filter = { allow: ["tool_a", "tool_b"] } as const;
    expect(passesToolFilter("tool_a", filter)).toBe(true);
    expect(passesToolFilter("tool_b", filter)).toBe(true);
  });

  it("rejects tools not in the allow list", () => {
    const filter = { allow: ["tool_a"] } as const;
    expect(passesToolFilter("tool_c", filter)).toBe(false);
  });

  it("rejects all tools when allow list is empty", () => {
    const filter = { allow: [] as string[] } as const;
    expect(passesToolFilter("anything", filter)).toBe(false);
  });

  it("passes tools not in the block list", () => {
    const filter = { block: ["dangerous_tool"] } as const;
    expect(passesToolFilter("safe_tool", filter)).toBe(true);
  });

  it("rejects tools in the block list", () => {
    const filter = { block: ["dangerous_tool"] } as const;
    expect(passesToolFilter("dangerous_tool", filter)).toBe(false);
  });

  it("passes all tools when block list is empty", () => {
    const filter = { block: [] as string[] } as const;
    expect(passesToolFilter("anything", filter)).toBe(true);
  });
});

describe("resolveHeaders", () => {
  it("produces a Bearer header from authorization", async () => {
    const headers = await resolveHeaders(makeConnection());

    expect(headers).toEqual({ Authorization: "Bearer test-token" });
  });

  it("passes principal { type: 'app' } to getToken for app-typed connections", async () => {
    let receivedPrincipal: unknown = "sentinel";
    const headers = await resolveHeaders(
      makeConnection({
        authorization: {
          async getToken(opts) {
            receivedPrincipal = opts.principal;
            return { token: "dynamic" };
          },
          principalType: "app",
        },
      }),
    );

    expect(headers).toEqual({ Authorization: "Bearer dynamic" });
    expect(receivedPrincipal).toEqual({ type: "app" });
  });

  it("passes connection.url to getToken so authorization callbacks can read the MCP URL", async () => {
    let receivedConnection: unknown = "sentinel";
    await resolveHeaders(
      makeConnection({
        authorization: {
          async getToken(opts) {
            receivedConnection = opts.connection;
            return { token: "dynamic" };
          },
          principalType: "app",
        },
        url: "https://mcp.example.com/custom",
      }),
    );

    expect(receivedConnection).toEqual({ url: "https://mcp.example.com/custom" });
  });

  it("forwards an async getToken result", async () => {
    const headers = await resolveHeaders(
      makeConnection({
        authorization: {
          getToken: () => Promise.resolve({ token: "async-token" }),
          principalType: "app",
        },
      }),
    );

    expect(headers).toEqual({ Authorization: "Bearer async-token" });
  });

  it("propagates errors thrown from getToken", async () => {
    await expect(
      resolveHeaders(
        makeConnection({
          authorization: {
            async getToken() {
              throw new Error("boom");
            },
            principalType: "app",
          },
        }),
      ),
    ).rejects.toThrow(/boom/);
  });

  it("resolves static headers", async () => {
    const headers = await resolveHeaders(
      makeConnection({
        authorization: undefined,
        headers: { "X-Api-Key": "key123", "X-App-Key": "app456" },
      }),
    );

    expect(headers).toEqual({ "X-Api-Key": "key123", "X-App-Key": "app456" });
  });

  it("resolves function-valued headers", async () => {
    const headers = await resolveHeaders(
      makeConnection({
        authorization: undefined,
        headers: { "X-Key": () => "from-fn" },
      }),
    );

    expect(headers).toEqual({ "X-Key": "from-fn" });
  });

  it("resolves a function-form headers definition", async () => {
    const headers = await resolveHeaders(
      makeConnection({
        authorization: undefined,
        headers: () => ({ "X-Dynamic": "all-at-once" }),
      }),
    );

    expect(headers).toEqual({ "X-Dynamic": "all-at-once" });
  });

  it("merges authorization and headers", async () => {
    const headers = await resolveHeaders(
      makeConnection({
        authorization: staticToken("bearer-tok"),
        headers: { "X-Extra": "val" },
      }),
    );

    expect(headers).toEqual({
      Authorization: "Bearer bearer-tok",
      "X-Extra": "val",
    });
  });

  it("throws when headers include Authorization alongside authorization", async () => {
    await expect(
      resolveHeaders(
        makeConnection({
          authorization: staticToken("bearer-tok"),
          headers: { Authorization: "Custom scheme" },
        }),
      ),
    ).rejects.toThrow(/must not include an "Authorization" key/);
  });

  it("allows Authorization in headers when authorization is absent", async () => {
    const headers = await resolveHeaders(
      makeConnection({
        authorization: undefined,
        headers: { Authorization: "Custom scheme" },
      }),
    );

    expect(headers.Authorization).toBe("Custom scheme");
  });

  it("returns empty object when neither authorization nor headers", async () => {
    const headers = await resolveHeaders(
      makeConnection({ authorization: undefined, headers: undefined }),
    );

    expect(headers).toEqual({});
  });
});

describe("resolveHeaders with an active context (principal resolution + cache)", () => {
  it("projects the session's user auth into a user principal and passes it to getToken", async () => {
    const ctx = ctxWithAuth(userAuth("alice"));

    let received: unknown;
    const connection = makeConnection({
      authorization: {
        async getToken(opts) {
          received = opts.principal;
          return { token: "alice-token" };
        },
        principalType: "user",
      },
      connectionName: "linear",
    });

    const headers = await contextStorage.run(ctx, () => resolveHeaders(connection));

    expect(headers).toEqual({ Authorization: "Bearer alice-token" });
    expect(received).toMatchObject({ id: "alice", issuer: "idp", type: "user" });
  });

  it("throws ConnectionAuthorizationFailedError (principal_required) for user-typed connections without any active context", async () => {
    // No contextStorage.run wrapper here — this mirrors ad-hoc CLI /
    // unit-test use where the session plumbing has not been set up.
    const connection = makeConnection({
      authorization: {
        getToken: async () => ({ token: "never-read" }),
        principalType: "user",
      },
      connectionName: "linear",
    });

    try {
      await resolveHeaders(connection);
      expect.fail("expected principal_required error");
    } catch (error) {
      expect(isConnectionAuthorizationFailedError(error)).toBe(true);
      if (isConnectionAuthorizationFailedError(error)) {
        expect(error.reason).toBe("principal_required");
        expect(error.retryable).toBe(false);
        expect(error.connectionName).toBe("linear");
      }
    }
  });

  it("throws ConnectionAuthorizationFailedError for user-typed connections when the session has no user", async () => {
    const ctx = ctxWithAuth(null);

    const connection = makeConnection({
      authorization: {
        getToken: async () => ({ token: "never-read" }),
        principalType: "user",
      },
      connectionName: "linear",
    });

    await contextStorage.run(ctx, async () => {
      try {
        await resolveHeaders(connection);
        expect.fail("expected principal_required error");
      } catch (error) {
        expect(isConnectionAuthorizationFailedError(error)).toBe(true);
      }
    });
  });

  it("caches tokens per-principal on the context (no re-invocation on repeat calls)", async () => {
    const ctx = ctxWithAuth(userAuth("alice"));

    let calls = 0;
    const connection = makeConnection({
      authorization: {
        async getToken() {
          calls += 1;
          return { token: `t-${calls}` };
        },
        principalType: "user",
      },
      connectionName: "linear",
    });

    await contextStorage.run(ctx, async () => {
      const first = await resolveHeaders(connection);
      const second = await resolveHeaders(connection);
      expect(first).toEqual(second);
      expect(calls).toBe(1);
    });

    const cached = ctx.get(ConnectionAuthorizationTokensKey);
    expect(cached).toEqual({ linear: { "user:idp:alice": { token: "t-1" } } });
  });

  it("uses separate cache slots for two users on the same connection", async () => {
    const tokens: Record<string, string> = {
      alice: "alice-token",
      bob: "bob-token",
    };

    const connection = makeConnection({
      authorization: {
        async getToken({ principal }) {
          if (principal.type !== "user") throw new Error("expected user principal");
          return { token: tokens[principal.id] ?? "unknown" };
        },
        principalType: "user",
      },
      connectionName: "linear",
    });

    const ctxAlice = ctxWithAuth(userAuth("alice"));
    const ctxBob = ctxWithAuth(userAuth("bob"));

    const aliceHeaders = await contextStorage.run(ctxAlice, () => resolveHeaders(connection));
    const bobHeaders = await contextStorage.run(ctxBob, () => resolveHeaders(connection));

    expect(aliceHeaders).toEqual({ Authorization: "Bearer alice-token" });
    expect(bobHeaders).toEqual({ Authorization: "Bearer bob-token" });
  });

  it("ignores session user for app-typed connections and does not leak user identity", async () => {
    const ctx = ctxWithAuth(userAuth("alice"));

    let received: unknown;
    const connection = makeConnection({
      authorization: {
        async getToken(opts) {
          received = opts.principal;
          return { token: "shared-app-token" };
        },
        principalType: "app",
      },
      connectionName: "api",
    });

    const headers = await contextStorage.run(ctx, () => resolveHeaders(connection));

    expect(headers).toEqual({ Authorization: "Bearer shared-app-token" });
    expect(received).toEqual({ type: "app" });
  });
});
