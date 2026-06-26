import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { AuthKey, type SessionAuthContext } from "#context/keys.js";
import { connectionProvider } from "#context/providers/connection.js";
import type { HarnessSession } from "#harness/types.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  mcpSessionStateKey,
  type DurableMcpSessionState,
  type McpSessionSlot,
} from "#runtime/connections/mcp-session-store.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

const initializeResult = {
  capabilities: {},
  protocolVersion: "2025-11-25",
  serverInfo: { name: "test-server", version: "1.0.0" },
} as const;

function durableState(sessionId: string): DurableMcpSessionState {
  return { initializeResult, sessionId };
}

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

function makeMcpConnection(
  name: string,
  overrides: Partial<ResolvedConnectionDefinition> = {},
): ResolvedConnectionDefinition {
  return {
    connectionName: name,
    description: "test connection",
    logicalPath: `connections/${name}.ts`,
    protocol: "mcp",
    sourceId: `connections/${name}`,
    sourceKind: "module",
    url: `https://example.com/${name}`,
    ...overrides,
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

function userAuth(principalId: string, issuer = "test-issuer"): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "test",
    issuer,
    principalId,
    principalType: "user",
  };
}

describe("connectionProvider.create", () => {
  it("seeds stateful MCP slots from session.state", async () => {
    const connectionName = "linear";
    const principalKey = "test-issuer:user-7";
    const stateKey = mcpSessionStateKey(connectionName, principalKey);

    const ctx = new ContextContainer();
    ctx.set(
      BundleKey,
      createBundle([makeMcpConnection(connectionName, { session: { mode: "stateful" } })]),
    );
    ctx.set(AuthKey, userAuth("user-7"));

    const session = createHarnessSession({ [stateKey]: durableState("persisted-session") });
    const result = await connectionProvider.create(ctx, session);

    expect(result).toBeDefined();
    expect(result!.value.collectMcpSessionUpdates()).toEqual([]);
  });

  it('uses the "anonymous" state key when no AuthKey is set', async () => {
    const connectionName = "anonymous-mcp";
    const stateKey = mcpSessionStateKey(connectionName, undefined);

    const ctx = new ContextContainer();
    ctx.set(
      BundleKey,
      createBundle([makeMcpConnection(connectionName, { session: { mode: "stateful" } })]),
    );

    const session = createHarnessSession({ [stateKey]: durableState("anon-session") });
    const result = await connectionProvider.create(ctx, session);

    expect(result).toBeDefined();
    expect(result!.value.collectMcpSessionUpdates()).toEqual([]);
  });

  it("returns undefined when there are no connections", () => {
    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle([]));

    expect(connectionProvider.create(ctx, createHarnessSession())).toBeUndefined();
  });
});

describe("connectionProvider.commit", () => {
  it("writes updated MCP session metadata into session.state", () => {
    const connectionName = "linear";
    const stateKey = mcpSessionStateKey(connectionName, "test-issuer:user-42");
    const slot: McpSessionSlot = {
      current: durableState("new-session"),
      initial: durableState("old-session"),
      stateKey,
    };
    const registry = new ConnectionRegistryImpl(
      [makeMcpConnection(connectionName, { session: { mode: "stateful" } })],
      new Map([[connectionName, slot]]),
    );

    const session = createHarnessSession({ existingKey: "should-survive" });
    const committed = connectionProvider.commit!(registry, session) as HarnessSession;

    expect(committed.state?.[stateKey]).toEqual(durableState("new-session"));
    expect(committed.state?.existingKey).toBe("should-survive");
  });

  it("deletes expired MCP session metadata from session.state", () => {
    const connectionName = "linear";
    const stateKey = mcpSessionStateKey(connectionName, "test-issuer:user-42");
    const slot: McpSessionSlot = {
      initial: durableState("expired-session"),
      stateKey,
    };
    const registry = new ConnectionRegistryImpl(
      [makeMcpConnection(connectionName, { session: { mode: "stateful" } })],
      new Map([[connectionName, slot]]),
    );

    const session = createHarnessSession({ [stateKey]: durableState("expired-session") });
    const committed = connectionProvider.commit!(registry, session) as HarnessSession;

    expect(committed.state?.[stateKey]).toBeUndefined();
  });

  it("returns the same session reference when no slot changed", () => {
    const connectionName = "notion";
    const stateKey = mcpSessionStateKey(connectionName, "anonymous");
    const unchanged = durableState("same-session");
    const registry = new ConnectionRegistryImpl(
      [makeMcpConnection(connectionName, { session: { mode: "stateful" } })],
      new Map([[connectionName, { current: unchanged, initial: unchanged, stateKey }]]),
    );
    const session = createHarnessSession({ [stateKey]: unchanged });

    expect(connectionProvider.commit!(registry, session)).toBe(session);
  });
});
