import { describe, expect, it } from "vitest";

import type { HarnessSession } from "#harness/types.js";
import { AuthKey, type SessionAuthContext } from "#context/keys.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { ContextContainer } from "#context/container.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { mcpSessionStateKey, type McpSessionSlot } from "#runtime/connections/mcp-session-store.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { connectionProvider } from "#context/providers/connection.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createHarnessSession(state?: Record<string, unknown>): HarnessSession {
  return {
    agent: {
      modelReference: { id: "openai/gpt-5.4" },
      system: "",
      tools: [],
    },
    compaction: {
      recentWindowSize: 0,
      threshold: 0,
    },
    continuationToken: "",
    history: [],
    sessionId: "session_1",
    state,
  };
}

function makeStatefulMcpConnection(name: string): ResolvedConnectionDefinition {
  return {
    connectionName: name,
    description: "test connection",
    logicalPath: `connections/${name}.ts`,
    protocol: "mcp",
    session: "stateful",
    sourceId: `connections/${name}`,
    sourceKind: "module",
    url: `https://example.com/${name}`,
  };
}

function makeStatelessMcpConnection(name: string): ResolvedConnectionDefinition {
  return {
    connectionName: name,
    description: "test connection",
    logicalPath: `connections/${name}.ts`,
    protocol: "mcp",
    sourceId: `connections/${name}`,
    sourceKind: "module",
    url: `https://example.com/${name}`,
  };
}

function createBundle(connections: readonly ResolvedConnectionDefinition[]): CompiledBundle {
  return {
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    graph: {
      root: {
        agent: {
          connections,
        },
        nodeId: "__root__",
      },
    },
  } as CompiledBundle;
}

function userAuth(principalId: string): SessionAuthContext {
  return {
    principalId,
    issuer: "test-issuer",
  } as SessionAuthContext;
}

// ---------------------------------------------------------------------------
// commit: round-trip — slot changed → state updated
// ---------------------------------------------------------------------------

describe("connectionProvider.commit", () => {
  it("writes updated sessionId into session.state", () => {
    const principalId = "user-42";
    const connectionName = "linear";
    const stateKey = mcpSessionStateKey(connectionName, principalId);

    const initialId = "old-session-id";
    const newSessionId = "new-session-id";

    const slot: McpSessionSlot = { stateKey, initialId, sessionId: newSessionId };
    const slots = new Map([[connectionName, slot]]);
    const registry = new ConnectionRegistryImpl([makeStatefulMcpConnection(connectionName)], slots);

    const session = createHarnessSession({ existingKey: "should-survive" });
    const committed = connectionProvider.commit!(registry, session) as HarnessSession;

    expect(committed.state?.[stateKey]).toBe(newSessionId);
    // Unrelated keys must be preserved.
    expect(committed.state?.["existingKey"]).toBe("should-survive");
  });

  it("does not mutate the original session object", () => {
    const connectionName = "slack";
    const stateKey = mcpSessionStateKey(connectionName, "u1");

    const slot: McpSessionSlot = { stateKey, initialId: "a", sessionId: "b" };
    const slots = new Map([[connectionName, slot]]);
    const registry = new ConnectionRegistryImpl([makeStatefulMcpConnection(connectionName)], slots);

    const session = createHarnessSession();
    const committed = connectionProvider.commit!(registry, session) as HarnessSession;

    expect(committed).not.toBe(session);
    expect(session.state).toBeUndefined();
  });

  it("returns the same session reference when no slot changed (no-op)", () => {
    const connectionName = "notion";
    const stateKey = mcpSessionStateKey(connectionName, "anon");
    const sessionId = "unchanged-id";

    // sessionId === initialId → no update
    const slot: McpSessionSlot = { stateKey, initialId: sessionId, sessionId };
    const slots = new Map([[connectionName, slot]]);
    const registry = new ConnectionRegistryImpl([makeStatefulMcpConnection(connectionName)], slots);

    const session = createHarnessSession({ [stateKey]: sessionId });
    const result = connectionProvider.commit!(registry, session);

    expect(result).toBe(session);
  });

  it("returns the same session reference when no stateful connections exist", () => {
    const registry = new ConnectionRegistryImpl([makeStatelessMcpConnection("github")]);
    const session = createHarnessSession();
    const result = connectionProvider.commit!(registry, session);

    expect(result).toBe(session);
  });
});

// ---------------------------------------------------------------------------
// create: seeding from session.state
// ---------------------------------------------------------------------------

describe("connectionProvider.create", () => {
  it("seeds stateful MCP slots from session.state so no update is emitted when unchanged", async () => {
    const connectionName = "linear";
    const principalId = "user-7";
    const persistedId = "persisted-session-abc";
    const stateKey = mcpSessionStateKey(connectionName, principalId);

    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle([makeStatefulMcpConnection(connectionName)]));
    ctx.set(AuthKey, userAuth(principalId));

    const session = createHarnessSession({ [stateKey]: persistedId });
    const result = await connectionProvider.create(ctx, session);

    expect(result).toBeDefined();
    const registry = result!.value as ConnectionRegistryImpl;

    // The slot was seeded with initialId === persistedId and sessionId ===
    // persistedId (unchanged), so collectMcpSessionUpdates must be empty.
    const updates = registry.collectMcpSessionUpdates();
    expect(updates).toHaveLength(0);
  });

  it("uses 'anonymous' principal when no AuthKey is set", async () => {
    const connectionName = "mcp-anon";
    const persistedId = "anon-session";
    const stateKey = mcpSessionStateKey(connectionName, undefined);

    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle([makeStatefulMcpConnection(connectionName)]));
    // intentionally no AuthKey set

    const session = createHarnessSession({ [stateKey]: persistedId });
    const result = await connectionProvider.create(ctx, session);

    expect(result).toBeDefined();
    const updates = result!.value.collectMcpSessionUpdates();
    // Seeded and unchanged → no updates.
    expect(updates).toHaveLength(0);
  });

  it("returns undefined when there are no connections", () => {
    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle([]));

    const session = createHarnessSession();
    const result = connectionProvider.create(ctx, session);

    expect(result).toBeUndefined();
  });
});
