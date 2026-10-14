import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contextStorage, ContextContainer } from "#context/container.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import {
  ConnectionAuthorizationRequiredError,
  isConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import {
  createStatefulMcpServer,
  type StatefulMcpServer,
} from "#internal/testing/stateful-mcp-server.js";
import { McpConnectionClient } from "#runtime/connections/mcp-client.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

const connection: ResolvedConnectionDefinition = {
  connectionName: "fixture",
  description: "stateful MCP fixture",
  logicalPath: "agent/connections/fixture.ts",
  protocol: "mcp",
  sourceId: "connections/fixture",
  sourceKind: "module",
  url: "http://127.0.0.1:8000/mcp",
};

/** A runtime scope, which token caching and eviction need. */
function runtimeScope(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  });
  return ctx;
}

/** Lets every queued promise continuation run. */
async function drainContinuations(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const callOptions = { callId: "call-1", abortSignal: undefined } as never;

describe("McpConnectionClient reset and close", () => {
  let server: StatefulMcpServer;

  beforeEach(() => {
    server = createStatefulMcpServer();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Sign-in completion resets and reconnects a client while an earlier
  // listing may still be running past its timeout.
  it("a listing that outlives a reset leaves the reconnected client's tools in charge", async () => {
    const client = new McpConnectionClient(connection);
    const firstList = server.hold((request) => request.rpcMethod === "tools/list");
    const stale = client.getToolMetadata();
    stale.catch(() => {});
    await firstList.reached;

    // Reconnect before the reset has settled, as a caller that doesn't
    // await it would.
    const resetting = client.reset();
    const fresh = client.getToolMetadata();
    await expect(stale).rejects.toThrow();
    const again = client.getToolMetadata();
    await resetting;

    await expect(fresh).resolves.toEqual([expect.objectContaining({ name: "ping" })]);
    await expect(again).resolves.toEqual(await fresh);
    await expect(client.executeTool("ping", {}, callOptions)).resolves.toMatchObject({
      content: [{ text: "pong", type: "text" }],
    });

    // One listing per session: the stale one and the reconnected one.
    const listings = server.requests.filter((request) => request.rpcMethod === "tools/list");
    expect(listings).toHaveLength(1);
    await client.close();
    expect(server.liveSessions.size).toBe(0);
  });

  it("a closed client opens no new session", async () => {
    const client = new McpConnectionClient(connection);
    await client.getToolMetadata();
    await client.close();

    await expect(client.getToolMetadata()).rejects.toThrow('MCP connection "fixture" is closed.');
    await expect(client.executeTool("ping", {}, callOptions)).rejects.toThrow(
      'MCP connection "fixture" is closed.',
    );
    const initializes = server.requests.filter((request) => request.rpcMethod === "initialize");
    expect(initializes).toHaveLength(1);
    expect(server.liveSessions.size).toBe(0);
  });

  it("an abandoned connect's anonymous token lookup doesn't decide how the next connect's 401 is handled", async () => {
    const evict = vi.fn();
    const firstLookup = Promise.withResolvers<void>();
    const firstLookupReached = Promise.withResolvers<void>();
    let lookups = 0;
    const client = new McpConnectionClient({
      ...connection,
      authorization: {
        evict,
        getToken: async () => {
          lookups += 1;
          if (lookups > 1) return { token: "signed-in" };
          firstLookupReached.resolve();
          await firstLookup.promise;
          throw new ConnectionAuthorizationRequiredError("fixture");
        },
        principalType: "app",
      },
    });

    await contextStorage.run(runtimeScope(), async () => {
      const abandoned = client.getToolMetadata();
      abandoned.catch(() => {});
      await firstLookupReached.promise;
      const resetting = client.reset();
      await client.getToolMetadata();

      // The abandoned lookup finishes with no token after the next connect got one.
      firstLookup.resolve();
      await drainContinuations();

      server.rejectUnauthorized((request) => request.rpcMethod === "tools/call");
      const error = await client
        .executeTool("ping", {}, callOptions)
        .catch((caught: unknown) => caught);
      expect(isConnectionAuthorizationRequiredError(error)).toBe(true);
      expect((error as Error).message).toContain("the server rejected the token");
      expect(evict).toHaveBeenCalledOnce();
      await resetting;
    });
    await client.close();
  });

  it("an abandoned listing's 401 doesn't close the next connect's session", async () => {
    const eviction = Promise.withResolvers<void>();
    const evictionReached = Promise.withResolvers<void>();
    const client = new McpConnectionClient({
      ...connection,
      authorization: {
        evict: async () => {
          evictionReached.resolve();
          await eviction.promise;
        },
        getToken: async () => ({ token: "t" }),
        principalType: "app",
      },
    });

    await contextStorage.run(runtimeScope(), async () => {
      server.rejectUnauthorized((request) => request.rpcMethod === "tools/list");
      const abandoned = client.getToolMetadata();
      abandoned.catch(() => {});
      // The first listing got its 401 and is evicting the token when sign-in
      // completion resets the client and the next connect starts.
      await evictionReached.promise;
      await client.reset();
      await client.getToolMetadata();
      const live = [...server.liveSessions];

      eviction.resolve();
      await expect(abandoned).rejects.toThrow(ConnectionAuthorizationRequiredError);

      expect(live).toHaveLength(1);
      expect([...server.liveSessions]).toEqual(live);
      await expect(client.executeTool("ping", {}, callOptions)).resolves.toMatchObject({
        content: [{ text: "pong", type: "text" }],
      });
      const initializes = server.requests.filter((request) => request.rpcMethod === "initialize");
      expect(initializes).toHaveLength(2);
    });
    await client.close();
  });
});
