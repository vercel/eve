import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledConnectionDefinition,
} from "#compiler/manifest.js";
import { normalizeMcpClientConnectionDefinition } from "#internal/authored-definition/connection.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import {
  resolveConnectionDefinition,
  resolveDynamicConnectionValue,
} from "#runtime/resolve-connection.js";
import { McpConnectionClient } from "#runtime/connections/mcp-client.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey } from "#context/keys.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";

describe.each(["static", "dynamic"] as const)(
  "%s MCP protocol configuration with the bundled client",
  (kind) => {
    const requests: { method: string; protocolVersion: string | null }[] = [];
    let client: McpConnectionClient;
    let discoveryError: { code: number; message: string; data?: unknown } | undefined;
    let discoveryDelayMs: number;
    let initializeError: { code: number; message: string } | undefined;
    let callResult: Record<string, unknown>;

    async function createClient(protocolVersionDiscovery?: boolean) {
      const authored = defineMcpClientConnection({
        description: "Support cases",
        headers: { Authorization: "Bearer fixture-token", "X-Workspace": "fixture-workspace" },
        instanceKey: "fixture-workspace",
        protocolVersionDiscovery,
        url: "https://mcp.example.com/mcp",
      });
      const normalized = normalizeMcpClientConnectionDefinition(authored, "Invalid connection:");
      const compiled: CompiledConnectionDefinition = {
        connectionName: "plain",
        description: normalized.description,
        logicalPath: "connections/plain.ts",
        protocol: "mcp",
        sourceId: "connections/plain",
        sourceKind: "module",
        url: normalized.url,
      };
      const resolved =
        kind === "dynamic"
          ? resolveDynamicConnectionValue(authored, compiled)
          : await resolveConnectionDefinition(
              compiled,
              {
                nodes: {
                  [ROOT_COMPILED_AGENT_NODE_ID]: {
                    modules: { [compiled.sourceId]: { default: authored } },
                  },
                },
              },
              undefined,
            );
      client = new McpConnectionClient(resolved);
      return client;
    }

    beforeEach(() => {
      requests.length = 0;
      discoveryError = {
        code: -32022,
        data: {
          requested: "2026-07-28",
          supported: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"],
        },
        message: "Unsupported protocol version",
      };
      discoveryDelayMs = 0;
      initializeError = undefined;
      callResult = { content: [{ type: "text", text: "fixture-user" }] };

      // Replace only HTTP I/O: eve's connection, bundled SDK, and protocol parsing stay real.
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://mcp.example.com/mcp");
        expect(request.headers.get("Authorization")).toBe("Bearer fixture-token");
        expect(request.headers.get("X-Workspace")).toBe("fixture-workspace");
        expect(request.method).toBe("POST");
        const message = (await request.json()) as {
          id?: number;
          method: string;
          params?: { name?: string; protocolVersion?: string };
        };
        const protocolVersion = request.headers.get("MCP-Protocol-Version");
        requests.push({ method: message.method, protocolVersion });

        let result: Record<string, unknown>;
        switch (message.method) {
          case "server/discover":
            await new Promise((resolve) => setTimeout(resolve, discoveryDelayMs));
            if (discoveryError !== undefined) {
              return Response.json({ jsonrpc: "2.0", id: message.id, error: discoveryError });
            }
            result = { capabilities: { tools: {} }, supportedVersions: ["2026-07-28"] };
            break;
          case "initialize":
            expect(protocolVersion).toBe("2025-11-25");
            expect(message.params?.protocolVersion).toBe("2025-11-25");
            if (initializeError !== undefined) {
              return Response.json({ jsonrpc: "2.0", id: message.id, error: initializeError });
            }
            result = {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "support-fixture", version: "1.0.0" },
            };
            break;
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            result = {
              tools: [{ name: "getMyUser", inputSchema: { type: "object", properties: {} } }],
            };
            break;
          case "tools/call":
            expect(message.params?.name).toBe("getMyUser");
            result = callResult;
            break;
          default:
            throw new Error(`Unexpected MCP method: ${message.method}`);
        }
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: protocolVersion === "2026-07-28" ? { ...result, resultType: "complete" } : result,
        });
      });
    });

    afterEach(async () => {
      await client?.close();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("initializes and calls Plain-style tools with discovery disabled", async () => {
      await createClient(false);
      await expect(client.getToolMetadata()).resolves.toEqual([
        expect.objectContaining({ name: "getMyUser" }),
      ]);
      await expect(client.executeTool("getMyUser", {}, { callId: "read-user" })).resolves.toEqual({
        content: [{ type: "text", text: "fixture-user" }],
        isError: false,
      });
      expect(requests).toEqual([
        { method: "initialize", protocolVersion: "2025-11-25" },
        { method: "notifications/initialized", protocolVersion: "2025-11-25" },
        { method: "tools/list", protocolVersion: "2025-11-25" },
        { method: "tools/call", protocolVersion: "2025-11-25" },
      ]);
    });

    it.each([undefined, true])("keeps discovery enabled when the option is %s", async (option) => {
      await createClient(option);
      discoveryError = undefined;
      await expect(client.getToolMetadata()).resolves.toEqual([
        expect.objectContaining({ name: "getMyUser" }),
      ]);
      expect(requests).toEqual([
        { method: "server/discover", protocolVersion: "2026-07-28" },
        { method: "tools/list", protocolVersion: "2026-07-28" },
      ]);
    });

    it("preserves Plain's version error when discovery is not disabled", async () => {
      await createClient();
      await expect(client.connect()).rejects.toMatchObject(discoveryError!);
      expect(requests).toEqual([{ method: "server/discover", protocolVersion: "2026-07-28" }]);
    });

    it("stays on the modern protocol when a modern-only server answers discovery slowly", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await createClient();
      discoveryError = undefined;
      discoveryDelayMs = 2_000;
      initializeError = { code: -32022, message: "Unsupported protocol version: 2025-11-25" };

      await Promise.all([
        expect(client.getToolMetadata()).resolves.toEqual([
          expect.objectContaining({ name: "getMyUser" }),
        ]),
        vi.advanceTimersByTimeAsync(discoveryDelayMs),
      ]);
      expect(requests).toEqual([
        { method: "server/discover", protocolVersion: "2026-07-28" },
        { method: "tools/list", protocolVersion: "2026-07-28" },
      ]);
    });

    it("propagates a failed handshake without retrying it or switching transports", async () => {
      await createClient(false);
      initializeError = { code: -32603, message: "Initialization failed" };
      await expect(client.connect()).rejects.toMatchObject(initializeError);
      expect(requests).toEqual([{ method: "initialize", protocolVersion: "2025-11-25" }]);
    });
  },
);

describe("MCP bearer refresh with the bundled client", () => {
  let client: McpConnectionClient;
  let token: string;
  let acceptedToken: string;
  let status: number;
  const requests: { method: string; bearer: string | null }[] = [];
  const getToken = vi.fn();
  const evict = vi.fn();
  const ctx = new ContextContainer();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    ctx.clearVirtualContext();
    ctx.set(AuthKey, {
      attributes: {},
      authenticator: "test",
      issuer: "test",
      principalId: "alice",
      principalType: "user",
    });
    ctx.set(InitiatorAuthKey, {
      attributes: {},
      authenticator: "test",
      issuer: "test",
      principalId: "bob",
      principalType: "user",
    });
    token = "first-token";
    acceptedToken = token;
    status = 200;
    requests.length = 0;
    getToken
      .mockReset()
      .mockImplementation(async () => ({ token, expiresAt: Date.now() + 60_000 }));
    evict.mockReset();
    client = new McpConnectionClient({
      authorization: { getToken, evict, principalType: "user" },
      connectionName: "test",
      description: "Read the current user",
      forwardPrincipal: true,
      logicalPath: "connections/test.ts",
      protocol: "mcp",
      protocolVersionDiscovery: false,
      sourceId: "connections/test",
      sourceKind: "module",
      url: "https://mcp.example.com/mcp",
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const message = (await request.json()) as { id?: number; method: string };
      const bearer = request.headers.get("authorization");
      const forwarded = request.headers.get("eve-forwarded-principal");
      expect(forwarded).not.toBeNull();
      expect(JSON.parse(Buffer.from(forwarded!, "base64url").toString())).toEqual({
        current: ctx.get(AuthKey),
        initiator: ctx.get(InitiatorAuthKey),
      });
      expect(request.redirect).toBe("error");
      requests.push({ method: message.method, bearer });
      if (status !== 200 || bearer !== `Bearer ${acceptedToken}`) {
        return new Response("Access denied", { status: status === 200 ? 401 : status });
      }
      let result: Record<string, unknown>;
      switch (message.method) {
        case "initialize":
          result = {
            capabilities: { tools: {} },
            protocolVersion: "2025-11-25",
            serverInfo: { name: "refresh-fixture", version: "1.0.0" },
          };
          break;
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          result = { tools: [{ name: "whoami", inputSchema: { type: "object", properties: {} } }] };
          break;
        case "tools/call":
          result = { content: [{ type: "text", text: "alice" }] };
          break;
        default:
          throw new Error(`Unexpected MCP method: ${message.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    });
  });

  afterEach(async () => {
    await client.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const call = () =>
    contextStorage.run(ctx, () => client.executeTool("whoami", {}, { callId: "read" }));

  it("refreshes an expired bearer on a live MCP client without consent or another handshake", async () => {
    await call();
    token = acceptedToken = "refreshed-token";
    vi.setSystemTime(Date.now() + 60_001);
    await expect(call()).resolves.toMatchObject({ content: [{ text: "alice" }] });
    expect(
      requests
        .filter((request) => request.method === "tools/call")
        .map((request) => request.bearer),
    ).toEqual(["Bearer first-token", "Bearer refreshed-token"]);
    expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    expect(evict).not.toHaveBeenCalled();
  });

  it("silently reacquires a rejected bearer and retries the request once", async () => {
    await call();
    token = acceptedToken = "replacement-token";
    await expect(call()).resolves.toMatchObject({ content: [{ text: "alice" }] });
    expect(
      requests
        .filter((request) => request.method === "tools/call")
        .map((request) => request.bearer),
    ).toEqual(["Bearer first-token", "Bearer first-token", "Bearer replacement-token"]);
    expect(evict).toHaveBeenCalledOnce();
  });

  it("resolves credentials in the current execution context rather than the connect context", async () => {
    await call();
    token = acceptedToken = "next-execution-token";
    const nextExecution = new ContextContainer();
    nextExecution.set(AuthKey, ctx.get(AuthKey)!);
    nextExecution.set(InitiatorAuthKey, ctx.get(InitiatorAuthKey)!);

    await expect(
      contextStorage.run(nextExecution, () =>
        client.executeTool("whoami", {}, { callId: "next-execution" }),
      ),
    ).resolves.toMatchObject({ content: [{ text: "alice" }] });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    expect(requests.at(-1)?.bearer).toBe("Bearer next-execution-token");
    expect(evict).not.toHaveBeenCalled();
  });

  it("requires consent when the refreshed bearer is also rejected, without looping", async () => {
    await call();
    token = "replacement-token";
    acceptedToken = "unavailable-token";
    await expect(call()).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
    expect(requests.filter((request) => request.method === "tools/call")).toHaveLength(3);
  });

  it("keeps missing grants in the existing consent flow", async () => {
    await call();
    getToken.mockRejectedValue(new ConnectionAuthorizationRequiredError("test"));
    vi.setSystemTime(Date.now() + 60_001);
    await expect(call()).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
    expect(requests.filter((request) => request.method === "tools/call").at(-1)?.bearer).toBeNull();
  });

  it("evicts a rejected replacement bearer even when another user makes an anonymous request", async () => {
    await call();
    token = "replacement-token";
    acceptedToken = "unavailable-token";
    getToken.mockImplementation(async ({ principal }) => {
      if (principal.id === "bob") throw new ConnectionAuthorizationRequiredError("test");
      return { token, expiresAt: Date.now() + 60_000 };
    });
    const bob = new ContextContainer();
    bob.set(AuthKey, { ...ctx.get(AuthKey)!, principalId: "bob" });
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const message = (await request.json()) as { id?: number; method: string };
      if (request.headers.get("authorization") === null) {
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "anonymous" }] },
        });
      }
      if (request.headers.get("authorization") === "Bearer replacement-token") {
        await expect(
          contextStorage.run(bob, () => client.executeTool("whoami", {}, { callId: "bob" })),
        ).resolves.toMatchObject({ content: [{ text: "anonymous" }] });
      }
      return await fetch(input, init);
    });

    await expect(call()).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
    expect(evict).toHaveBeenCalledTimes(2);
    expect(evict.mock.calls.map(([options]) => options.principal.id)).toEqual(["alice", "alice"]);
  });

  it("does not refresh or retry a team permission failure", async () => {
    await call();
    status = 403;
    await expect(call()).rejects.toThrow();
    expect(requests.filter((request) => request.method === "tools/call")).toHaveLength(2);
    expect(evict).not.toHaveBeenCalled();
  });
});
