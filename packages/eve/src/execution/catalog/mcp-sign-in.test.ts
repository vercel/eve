import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_TOOL_NAME, SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";

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

import { catalogBundle } from "#internal/testing/catalog-fixtures.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { buildStepCatalog } from "./step-catalog.js";

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
}

/**
 * Alice's session with one MCP connection, `kennel`, served by a stubbed
 * `fetch` and reached through the real MCP client, `search`, and `execute`.
 */
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
    seen.push({ authorization, method: message.method });
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
  const connection = {
    authorization: defineInteractiveAuthorization({
      getToken: async () => {
        if (token === undefined) throw new ConnectionAuthorizationRequiredError("kennel");
        return { token };
      },
      startAuthorization,
      completeAuthorization: async () => {
        token = TOKEN;
        return { token };
      },
    }),
    connectionName: "kennel",
    description: "Pet boarding.",
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
  registries.push(registry);

  const ctx = new ContextContainer();
  ctx.set(AuthKey, {
    attributes: {},
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
  });
  ctx.set(SessionIdKey, "mcp-sign-in");
  ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
  ctx.set(ConnectionRegistryKey, registry);
  ctx.set(BundleKey, catalogBundle({ connections: [connection] }));
  const catalog = buildStepCatalog({ agentTools: new Map(), ctx, endsTurn: true, session: {} });
  const options = { messages: [], toolCallId: "call-1" };

  return {
    seen,
    startAuthorization,
    search: (query: string) =>
      contextStorage.run(ctx, () =>
        catalog.advertised.get(SEARCH_TOOL_NAME)!.execute!({ query }, options),
      ),
    /** Runs `eve__tool({ name, input })` the way the harness runs a resolved call. */
    execute: (tool: string, input: object = {}) => {
      const resolved = catalog.resolve({ input: { input, name: tool }, toolName: CALL_TOOL_NAME });
      if (resolved === undefined) throw new Error(`execute could not resolve "${tool}".`);
      return contextStorage.run(ctx, () =>
        resolved.definition.execute!(resolved.call.input, options),
      );
    },
    /** Delivers the finished sign-in, as the turn step does when its callback arrives. */
    finishSignIn: () =>
      ctx.set(PendingAuthorizationResultKey, [
        {
          callback: { method: "GET", params: { code: "ok" } },
          hookUrl: "https://agent.example.com/callback",
          name: "kennel",
        },
      ]),
  };
}

const registries: ConnectionRegistry[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()));
  vi.unstubAllGlobals();
});

describe("MCP connections sign in only when the server asks", () => {
  it("searches a server that lists its tools anonymously, with no prompt and no sign-in result", async () => {
    const kennel = setup("public-list-401");

    const output = await kennel.search("kennel");

    expect(output).toEqual({
      results: [
        expect.objectContaining({ tool: "kennel__find_pet" }),
        expect.objectContaining({ tool: "kennel__pet_invoice" }),
      ],
    });
    expect(kennel.startAuthorization).not.toHaveBeenCalled();
    expect(kennel.seen.every((request) => request.authorization === null)).toBe(true);
  });

  it.each(["public-list-401", "public-list-meta"] as const)(
    "%s: runs a public tool anonymously, then signs in for a protected tool and calls it with the token",
    async (mode) => {
      const kennel = setup(mode);

      expect(await kennel.execute("kennel__find_pet")).toBe("find_pet ok");
      expect(kennel.startAuthorization).not.toHaveBeenCalled();

      const parked = await kennel.execute("kennel__pet_invoice");
      expect(isAuthorizationSignal(parked)).toBe(true);
      expect(parked).toMatchObject({ challenges: [{ name: "kennel" }] });
      expect(kennel.startAuthorization).toHaveBeenCalledOnce();

      kennel.finishSignIn();
      const before = kennel.seen.length;
      expect(await kennel.execute("kennel__pet_invoice")).toBe("pet_invoice ok");
      const resumed = kennel.seen.slice(before);
      expect(resumed.map((request) => request.method)).toContain("initialize");
      expect(resumed.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
      expect(kennel.startAuthorization).toHaveBeenCalledOnce();
    },
  );

  it("reconnects with the token after sign-in, even when a public call reopened an anonymous connection", async () => {
    const kennel = setup("public-list-401");
    await kennel.execute("kennel__pet_invoice");
    // While the sign-in is pending, a public call connects anonymously again.
    expect(await kennel.execute("kennel__find_pet")).toBe("find_pet ok");

    kennel.finishSignIn();
    const before = kennel.seen.length;

    expect(await kennel.execute("kennel__pet_invoice")).toBe("pet_invoice ok");
    const resumed = kennel.seen.slice(before);
    expect(resumed[0]).toEqual({ authorization: `Bearer ${TOKEN}`, method: "initialize" });
    expect(resumed.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(kennel.startAuthorization).toHaveBeenCalledOnce();
  });

  it("finds a server that rejects anonymous listing as its sign-in result, which signs in", async () => {
    const kennel = setup("token-everywhere");

    expect(await kennel.search("kennel__")).toEqual({
      results: [
        {
          description: "Sign in to use the Kennel tools: Pet boarding.",
          signature: "kennel(input: {}): Promise<unknown>",
          tool: "kennel",
        },
      ],
    });
    expect(kennel.startAuthorization).not.toHaveBeenCalled();

    expect(isAuthorizationSignal(await kennel.execute("kennel"))).toBe(true);
    kennel.finishSignIn();
    expect(await kennel.execute("kennel")).toBe(
      'Signed in to Kennel. Find the Kennel tools with eve__search({ query: "kennel__" }).',
    );
    expect(await kennel.search("kennel__")).toMatchObject({
      results: [{ tool: "kennel__find_pet" }, { tool: "kennel__pet_invoice" }],
    });
  });
});
