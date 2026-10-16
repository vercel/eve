import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { withContextScope } from "#context/run-step.js";
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
function stepContext(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    graph: { root: { agent: { connections: [connection], dynamicConnectionResolvers: [] } } },
  } as never);
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

  it("a step returns within the termination deadline when the server never answers DELETE", async () => {
    const ctx = stepContext();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    // A server that stopped answering: the DELETE arrives and never gets a response, but ends when aborted.
    let deleteArrived!: () => void;
    const terminationReached = new Promise<void>((resolve) => {
      deleteArrived = resolve;
    });
    vi.stubGlobal("fetch", (...[input, init]: Parameters<typeof fetch>) => {
      const signal = init?.signal;
      if (init?.method !== "DELETE") return server.fetch(input, init);
      deleteArrived();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    let settled = false;
    const scope = withContextScope(ctx, {} as HarnessSessionBase, async (session) => {
      await ctx.require(ConnectionRegistryKey).getClient("fixture").getToolMetadata();
      return { result: undefined, session };
    }).finally(() => {
      settled = true;
    });

    await terminationReached;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await scope;
    expect(settled).toBe(true);
  });
});
