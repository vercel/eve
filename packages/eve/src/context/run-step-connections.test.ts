import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { withContextScope } from "#context/run-step.js";
import { completeConnectionSignIn, listToolMetadata } from "#execution/catalog/connection-auth.js";
import type { HarnessSessionBase } from "#harness/types.js";
import {
  createStatefulMcpServer,
  type StatefulMcpServer,
} from "#internal/testing/stateful-mcp-server.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

vi.mock("#context/providers/session.js", () => ({
  sessionProvider: { create: () => undefined, key: { name: "test.session" } },
}));
vi.mock("#context/providers/tool-stubs.js", () => ({
  toolStubProvider: { create: () => undefined, key: { name: "test.toolStubs" } },
}));
vi.mock("#context/providers/sandbox.js", () => ({
  sandboxProvider: { create: () => undefined, key: { name: "test.sandbox" } },
}));

const connection: ResolvedConnectionDefinition = {
  connectionName: "fixture",
  description: "stateful MCP fixture",
  logicalPath: "agent/connections/fixture.ts",
  protocol: "mcp",
  sourceId: "connections/fixture",
  sourceKind: "module",
  url: "http://127.0.0.1:8000/mcp",
};

/** A fresh step context whose agent has the one connection. */
function stepContext(stepConnection = connection): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    graph: { root: { agent: { connections: [stepConnection], dynamicConnectionResolvers: [] } } },
  } as never);
  // Callbacks and token lookups read the session.
  ctx.set(AuthKey, null);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  });
  return ctx;
}

/** Runs one step whose body connects to the MCP server, then returns or throws. */
async function runStepUsingConnection(outcome: "commit" | "fail"): Promise<void> {
  const ctx = stepContext();
  const scope = withContextScope(ctx, {} as HarnessSessionBase, async (session) => {
    await ctx.require(ConnectionRegistryKey).getClient("fixture").getToolMetadata();
    if (outcome === "fail") throw new Error("step failed");
    return { result: undefined, session };
  });
  if (outcome === "fail") {
    await expect(scope).rejects.toThrow("step failed");
  } else {
    await scope;
  }
}

describe("withContextScope MCP session lifecycle", () => {
  let server: StatefulMcpServer;

  beforeEach(() => {
    server = createStatefulMcpServer();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function expectEverySessionEnded(sessions: number) {
    const deletes = server.requests.filter((request) => request.method === "DELETE");
    expect(deletes.map((request) => request.status)).toEqual(Array(sessions).fill(200));
    expect(server.liveSessions.size).toBe(0);
  }

  it.each(["commit", "fail"] as const)(
    "ends each step's MCP session when the step ends (%s)",
    async (outcome) => {
      await runStepUsingConnection(outcome);
      await runStepUsingConnection(outcome);

      const deletes = server.requests.filter((request) => request.method === "DELETE");
      expect(deletes.map((request) => request.status)).toEqual([200, 200]);
      expect(new Set(deletes.map((request) => request.sessionId)).size).toBe(2);
      expect(server.liveSessions.size).toBe(0);
    },
  );

  it("a step that fails during a hung handshake rejects at once and still ends the session", async () => {
    const ctx = stepContext();
    const handshake = server.hold((request) => request.rpcMethod === "notifications/initialized");
    let listing!: Promise<unknown>;
    const scope = withContextScope(ctx, {} as HarnessSessionBase, async () => {
      listing = ctx.require(ConnectionRegistryKey).getClient("fixture").getToolMetadata();
      listing.catch(() => {});
      await handshake.reached;
      throw new Error("step cancelled");
    });

    await expect(scope).rejects.toThrow("step cancelled");
    await expect(listing).rejects.toThrow();
    await server.waitForRequest((request) => request.method === "DELETE");

    expectEverySessionEnded(1);
  });

  it("the listing timeout ends a step whose handshake hangs, and the session still ends", async () => {
    const ctx = stepContext();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const handshake = server.hold((request) => request.rpcMethod === "notifications/initialized");
    const scope = withContextScope(ctx, {} as HarnessSessionBase, async (session) => {
      await listToolMetadata("fixture", ctx.require(ConnectionRegistryKey).getClient("fixture"));
      return { result: undefined, session };
    });
    scope.catch(() => {});

    await handshake.reached;
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(scope).rejects.toThrow("did not list its tools within 10s");
    await server.waitForRequest((request) => request.method === "DELETE");
    expectEverySessionEnded(1);
  });

  it("a step returns within the termination deadline when the server never answers DELETE", async () => {
    const ctx = stepContext();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const termination = server.hold((request) => request.method === "DELETE");
    let settled = false;
    const scope = withContextScope(ctx, {} as HarnessSessionBase, async (session) => {
      await ctx.require(ConnectionRegistryKey).getClient("fixture").getToolMetadata();
      return { result: undefined, session };
    }).finally(() => {
      settled = true;
    });

    await termination.reached;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await scope;
    expect(settled).toBe(true);
  });

  it("a step whose token lookup never returns ends at once and the lookup opens no session", async () => {
    const lookup = Promise.withResolvers<{ token: string }>();
    const lookupReached = Promise.withResolvers<void>();
    const ctx = stepContext({
      ...connection,
      authorization: {
        getToken: () => {
          lookupReached.resolve();
          return lookup.promise;
        },
        principalType: "app",
      },
    });
    let listing!: Promise<unknown>;
    const scope = withContextScope(ctx, {} as HarnessSessionBase, async () => {
      listing = ctx.require(ConnectionRegistryKey).getClient("fixture").getToolMetadata();
      listing.catch(() => {});
      await lookupReached.promise;
      throw new Error("step cancelled");
    });

    await expect(scope).rejects.toThrow("step cancelled");
    await expect(listing).rejects.toThrow();

    lookup.resolve({ token: "late" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(server.requests).toEqual([]);
  });

  it("a sign-in that finishes after its step ended opens no session", async () => {
    const authorization = Promise.withResolvers<{
      getToken: () => Promise<{ token: string }>;
      principalType: "app";
    }>();
    const authorizationReached = Promise.withResolvers<void>();
    const signInConnection: ResolvedConnectionDefinition = {
      ...connection,
      authorization: () => {
        authorizationReached.resolve();
        return authorization.promise;
      },
    };
    const ctx = stepContext(signInConnection);
    let signIn!: Promise<unknown>;
    const scope = withContextScope(ctx, {} as HarnessSessionBase, async () => {
      const registry = ctx.require(ConnectionRegistryKey);
      signIn = completeConnectionSignIn(registry, signInConnection).then(async ({ client }) => {
        await client.getToolMetadata();
      });
      signIn.catch(() => {});
      await authorizationReached.promise;
      throw new Error("step cancelled");
    });
    await expect(scope).rejects.toThrow("step cancelled");

    authorization.resolve({ getToken: async () => ({ token: "t" }), principalType: "app" });

    await expect(signIn).rejects.toThrow('Connection "fixture" was used after its step ended.');
    expect(server.requests).toEqual([]);
  });
});
