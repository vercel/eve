import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import {
  CallbackBaseUrlKey,
  isAuthorizationSignal,
  PendingAuthorizationResultKey,
} from "#harness/authorization.js";
import { McpConnectionClient } from "#runtime/connections/mcp-client.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { type ConnectionClient, defineInteractiveAuthorization } from "#shared/connection-types.js";

import { CONNECTION_EXECUTE_TOOL_NAME } from "./connection-target.js";
import { CONNECTION_SEARCH_TOOL_NAME, resolveConnectionTools } from "./connection-tools.js";

const URL = "https://kennel.example.com/mcp";
const TOKEN = "signed-in-token";

/** How the fake server treats requests that carry no bearer. */
type ServerMode =
  /** `initialize`/`tools/list` are public; a protected `tools/call` answers HTTP 401. */
  | "public-list-401"
  /** `initialize`/`tools/list` are public; a protected `tools/call` returns an `mcp/www_authenticate` error. */
  | "public-list-meta"
  /** Every request without a bearer answers HTTP 401. */
  | "token-everywhere";

interface SeenRequest {
  readonly authorization: string | null;
  readonly method: string;
  readonly tool?: string;
}

function setup(mode: ServerMode) {
  const seen: SeenRequest[] = [];
  vi.stubGlobal("fetch", async (input: string | globalThis.URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const authorization = request.headers.get("authorization");
    const message = (await request.json()) as {
      id?: number;
      method: string;
      params?: { name?: string };
    };
    seen.push({ authorization, method: message.method, tool: message.params?.name });
    const signedIn = authorization === `Bearer ${TOKEN}`;
    if (!signedIn && mode === "token-everywhere") {
      return new Response("Unauthorized", { status: 401 });
    }
    if (message.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return reply({
          capabilities: { tools: {} },
          protocolVersion: "2025-06-18",
          serverInfo: { name: "kennel", version: "1.0.0" },
        });
      case "tools/list":
        return reply({
          tools: [
            { name: "find_pet", description: "Find a pet.", inputSchema: { type: "object" } },
            { name: "pet_invoice", description: "A pet's bill.", inputSchema: { type: "object" } },
          ],
        });
      case "tools/call": {
        if (message.params?.name === "pet_invoice" && !signedIn) {
          if (mode === "public-list-401") return new Response("Unauthorized", { status: 401 });
          return reply({
            _meta: { "mcp/www_authenticate": [`Bearer resource_metadata="${URL}/.well-known"`] },
            content: [{ type: "text", text: "Sign in to see invoices." }],
            isError: true,
          });
        }
        return reply({ content: [{ type: "text", text: `${message.params?.name} ok` }] });
      }
      default:
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  });

  let token: string | undefined;
  const startAuthorization = vi.fn(async ({ callbackUrl }: { callbackUrl: string }) => ({
    challenge: { url: `https://idp.example.com/authorize?redirect=${callbackUrl}` },
  }));
  const authorization = defineInteractiveAuthorization({
    getToken: async () => {
      if (token === undefined) throw new ConnectionAuthorizationRequiredError("kennel");
      return { token };
    },
    startAuthorization,
    completeAuthorization: async () => {
      token = TOKEN;
      return { token };
    },
  });
  const connection = {
    authorization,
    connectionName: "kennel",
    description: "Kennel",
    protocol: "mcp",
    protocolVersionDiscovery: false,
    url: URL,
  } as ResolvedConnectionDefinition;

  const clients = new Map<string, ConnectionClient>();
  const registry: ConnectionRegistry = {
    dispose: async () => {
      await Promise.all([...clients.values()].map((client) => client.close()));
    },
    getClient: (name) => {
      let client = clients.get(name);
      if (client === undefined) {
        client = new McpConnectionClient(connection);
        clients.set(name, client);
      }
      return client;
    },
    getConnectionApproval: () => undefined,
    getConnectionNames: () => ["kennel"],
    getConnections: () => [connection],
  };

  const ctx = new ContextContainer();
  ctx.set(AuthKey, {
    attributes: {},
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
  });
  ctx.set(SessionIdKey, "lazy-auth");
  ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
  ctx.set(ConnectionRegistryKey, registry);

  async function call(toolName: string, input: unknown): Promise<unknown> {
    return await contextStorage.run(ctx, async () => {
      const execute = resolveConnectionTools()?.[toolName]?.execute;
      if (execute === undefined) throw new Error(`${toolName} is not defined.`);
      return await execute(input, { callId: "call-1", messages: [] } as never);
    });
  }

  /** Simulates the user finishing sign-in: the callback result arrives for the next step. */
  function completeSignIn() {
    ctx.set(PendingAuthorizationResultKey, [
      {
        callback: { method: "GET", params: { code: "ok" } },
        hookUrl: "https://agent.example.com/callback",
        name: "kennel",
      },
    ]);
  }

  return { call, completeSignIn, registry, seen, startAuthorization };
}

describe("MCP connections sign in only when the server asks", () => {
  let registry: ConnectionRegistry | undefined;

  beforeEach(() => {
    registry = undefined;
  });

  afterEach(async () => {
    await registry?.dispose();
    vi.unstubAllGlobals();
  });

  it("lists a public server's tools without a token or a sign-in prompt", async () => {
    const env = setup("public-list-401");
    registry = env.registry;

    const result = await env.call(CONNECTION_SEARCH_TOOL_NAME, { connection: "kennel" });

    expect(result).toMatchObject({
      tools: [{ tool: "find_pet" }, { tool: "pet_invoice" }],
      total: 2,
    });
    expect(result).not.toHaveProperty("unavailable");
    expect(env.startAuthorization).not.toHaveBeenCalled();
    expect(env.seen.every((request) => request.authorization === null)).toBe(true);
  });

  it.each(["public-list-401", "public-list-meta"] as const)(
    "%s: runs a public tool anonymously, then prompts on a protected tool and resumes with the token",
    async (mode) => {
      const env = setup(mode);
      registry = env.registry;

      await expect(
        env.call(CONNECTION_EXECUTE_TOOL_NAME, { connection: "kennel", tool: "find_pet" }),
      ).resolves.toBe("find_pet ok");
      expect(env.startAuthorization).not.toHaveBeenCalled();

      const signal = await env.call(CONNECTION_EXECUTE_TOOL_NAME, {
        connection: "kennel",
        tool: "pet_invoice",
      });
      expect(isAuthorizationSignal(signal)).toBe(true);
      expect(signal).toMatchObject({ challenges: [{ name: "kennel" }] });
      expect(env.startAuthorization).toHaveBeenCalledOnce();

      env.completeSignIn();
      const seenBefore = env.seen.length;
      await expect(
        env.call(CONNECTION_EXECUTE_TOOL_NAME, { connection: "kennel", tool: "pet_invoice" }),
      ).resolves.toBe("pet_invoice ok");
      const resumed = env.seen.slice(seenBefore);
      expect(resumed.map((request) => request.method)).toContain("initialize");
      expect(resumed.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
      expect(env.startAuthorization).toHaveBeenCalledOnce();
    },
  );

  it("keeps reporting requiresSignIn for servers that reject every anonymous request", async () => {
    const env = setup("token-everywhere");
    registry = env.registry;

    const result = await env.call(CONNECTION_SEARCH_TOOL_NAME, { connection: "kennel" });

    expect(result).toMatchObject({
      tools: [],
      unavailable: [{ connection: "kennel", requiresSignIn: true }],
    });
    expect(env.startAuthorization).not.toHaveBeenCalled();

    const signal = await env.call(CONNECTION_EXECUTE_TOOL_NAME, {
      connection: "kennel",
      tool: "find_pet",
    });
    expect(signal).toMatchObject({ challenges: [{ name: "kennel" }] });
  });
});
