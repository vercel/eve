import { describe, expect, it, vi } from "vitest";

import {
  CONNECTION_REGISTRY_CACHE_MAX_SESSIONS,
  disposeSessionConnectionRegistry,
  getSessionConnectionRegistry,
} from "#runtime/connections/registry-cache.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

function makeConnections(
  url: string = "https://mcp.example.com",
): readonly ResolvedConnectionDefinition[] {
  return [
    {
      connectionName: "test",
      description: "test connection",
      logicalPath: "connections/test.ts",
      protocol: "mcp",
      sourceId: "connections/test",
      sourceKind: "module",
      url,
    },
  ];
}

describe("connection registry cache", () => {
  it("reuses a registry for the same definitions and callback scope", async () => {
    const runtimeSession = createRuntimeSession("registry-cache-test");
    const connections = makeConnections();

    await withRuntimeSession(runtimeSession, async () => {
      const first = getSessionConnectionRegistry({
        connections,
        scopeKey: "caller-a:turn-1",
        sessionId: "session-1",
      });
      const second = getSessionConnectionRegistry({
        connections,
        scopeKey: "caller-a:turn-1",
        sessionId: "session-1",
      });

      expect(second).toBe(first);
      await disposeSessionConnectionRegistry("session-1");
    });
  });

  it("keeps concurrent scopes and definition versions live until terminal cleanup", async () => {
    const runtimeSession = createRuntimeSession("registry-cache-test");
    const firstConnections = makeConnections();
    const updatedConnections = makeConnections("https://updated-mcp.example.com");

    await withRuntimeSession(runtimeSession, async () => {
      const first = getSessionConnectionRegistry({
        connections: firstConnections,
        scopeKey: "caller-a:turn-1",
        sessionId: "session-1",
      });
      const otherScope = getSessionConnectionRegistry({
        connections: firstConnections,
        scopeKey: "caller-b:turn-2",
        sessionId: "session-1",
      });
      const updated = getSessionConnectionRegistry({
        connections: updatedConnections,
        scopeKey: "caller-a:turn-1",
        sessionId: "session-1",
      });
      const disposeFirst = vi.spyOn(first, "dispose");
      const disposeOtherScope = vi.spyOn(otherScope, "dispose");
      const disposeUpdated = vi.spyOn(updated, "dispose");

      expect(
        getSessionConnectionRegistry({
          connections: firstConnections,
          scopeKey: "caller-a:turn-1",
          sessionId: "session-1",
        }),
      ).toBe(first);
      expect(otherScope).not.toBe(first);
      expect(updated).not.toBe(first);
      expect(disposeFirst).not.toHaveBeenCalled();

      await disposeSessionConnectionRegistry("session-1");

      expect(disposeFirst).toHaveBeenCalledOnce();
      expect(disposeOtherScope).toHaveBeenCalledOnce();
      expect(disposeUpdated).toHaveBeenCalledOnce();
      expect(runtimeSession.connectionRegistryCache?.has("session-1")).toBe(false);
    });
  });

  it("lazily initializes cache state from an older process-default session", async () => {
    const runtimeSession = createRuntimeSession("registry-cache-compatibility-test");
    runtimeSession.connectionRegistryCache = undefined;

    await withRuntimeSession(runtimeSession, async () => {
      getSessionConnectionRegistry({
        connections: makeConnections(),
        scopeKey: "caller-a:turn-1",
        sessionId: "session-1",
      });

      expect(runtimeSession.connectionRegistryCache?.has("session-1")).toBe(true);
      await disposeSessionConnectionRegistry("session-1");
    });
  });

  it("evicts the least recently used session when the process cache reaches its bound", async () => {
    const runtimeSession = createRuntimeSession("registry-cache-bound-test");
    const connections = makeConnections();

    await withRuntimeSession(runtimeSession, async () => {
      const oldest = getSessionConnectionRegistry({
        connections,
        scopeKey: "caller-a:turn-1",
        sessionId: "session-0",
      });
      const disposeOldest = vi.spyOn(oldest, "dispose");

      for (let index = 1; index <= CONNECTION_REGISTRY_CACHE_MAX_SESSIONS; index += 1) {
        getSessionConnectionRegistry({
          connections,
          scopeKey: "caller-a:turn-1",
          sessionId: `session-${index}`,
        });
      }

      await vi.waitFor(() => expect(disposeOldest).toHaveBeenCalledOnce());
      expect(runtimeSession.connectionRegistryCache?.size).toBe(
        CONNECTION_REGISTRY_CACHE_MAX_SESSIONS,
      );
      expect(runtimeSession.connectionRegistryCache?.has("session-0")).toBe(false);
    });
  });

  it("does not cache registries without a durable session id", async () => {
    const runtimeSession = createRuntimeSession("registry-cache-empty-session-test");

    await withRuntimeSession(runtimeSession, async () => {
      getSessionConnectionRegistry({
        connections: makeConnections(),
        scopeKey: "caller-a:turn-1",
        sessionId: "",
      });

      expect(runtimeSession.connectionRegistryCache?.size).toBe(0);
      await disposeSessionConnectionRegistry("");
    });
  });
});
