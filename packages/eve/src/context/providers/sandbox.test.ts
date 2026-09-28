import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import type { HarnessSession } from "#harness/types.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { SessionIdKey } from "#context/keys.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { ContextContainer } from "#context/container.js";
import { sandboxProvider } from "#context/providers/sandbox.js";
import { createStubSandboxRegistry } from "#internal/testing/stub-sandbox-registry.js";

vi.mock("../../execution/sandbox/ensure.js", () => ({
  ensureSandboxAccess: vi.fn(),
}));

function createHarnessSession(
  overrides: Partial<Pick<HarnessSession, "sandboxState">> = {},
): HarnessSession {
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
    ...overrides,
  };
}

function createBundle(input: {
  readonly agentName: string;
  readonly registry: RuntimeSandboxRegistry;
}): CompiledBundle {
  return {
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    graph: {
      root: {
        agent: {
          config: {
            name: input.agentName,
          },
        },
        nodeId: "__root__",
        sandboxRegistry: input.registry,
      },
    },
  } as CompiledBundle;
}

describe("sandboxProvider", () => {
  beforeEach(() => {
    vi.mocked(ensureSandboxAccess).mockResolvedValue({
      captureState: vi.fn().mockResolvedValue({ initialized: false, session: null }),
      get: vi.fn().mockResolvedValue(null),
      stop: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("uses the latest parent state when a resumed child has stale persisted state", async () => {
    const ctx = new ContextContainer();
    const registry: RuntimeSandboxRegistry = createStubSandboxRegistry();
    const staleChildState = {
      session: {
        providerName: "test",
        state: { sandboxName: "stale-child" },
        stateProtocolVersion: 1,
      },
    };
    const latestParentState = {
      session: {
        providerName: "test",
        state: { sandboxName: "latest-parent" },
        stateProtocolVersion: 1,
      },
    };

    ctx.set(BundleKey, createBundle({ agentName: "weather-agent", registry }));
    ctx.set(ChannelKey, {
      kind: "subagent",
      state: { parentSandboxState: latestParentState, sandboxSessionId: "root-sandbox-session" },
    });
    ctx.set(SessionIdKey, "child-session");

    await sandboxProvider.create(ctx, createHarnessSession({ sandboxState: staleChildState }));

    expect(ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        ownsSandbox: false,
        sessionId: "root-sandbox-session",
        state: latestParentState,
      }),
    );
  });

  it("falls back to a resumed child state when parent state is absent", async () => {
    const ctx = new ContextContainer();
    const registry: RuntimeSandboxRegistry = createStubSandboxRegistry();
    const childState = {
      session: {
        providerName: "test",
        state: { sandboxName: "child" },
        stateProtocolVersion: 1,
      },
    };

    ctx.set(BundleKey, createBundle({ agentName: "weather-agent", registry }));
    ctx.set(ChannelKey, {
      kind: "subagent",
      state: { sandboxSessionId: "root-sandbox-session" },
    });
    ctx.set(SessionIdKey, "child-session");

    await sandboxProvider.create(ctx, createHarnessSession({ sandboxState: childState }));

    expect(ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        ownsSandbox: false,
        sessionId: "root-sandbox-session",
        state: childState,
      }),
    );
  });

  it("does not treat parent metadata as sharing for an independent root", async () => {
    const ctx = new ContextContainer();
    const registry: RuntimeSandboxRegistry = createStubSandboxRegistry();
    const rootState = {
      session: {
        providerName: "test",
        state: { sandboxName: "root" },
        stateProtocolVersion: 1,
      },
    };
    const ignoredParentState = {
      session: {
        providerName: "test",
        state: { sandboxName: "ignored-parent" },
        stateProtocolVersion: 1,
      },
    };

    ctx.set(BundleKey, createBundle({ agentName: "weather-agent", registry }));
    ctx.set(ChannelKey, { kind: "slack", state: { parentSandboxState: ignoredParentState } });
    ctx.set(SessionIdKey, "root-session");

    await sandboxProvider.create(ctx, createHarnessSession({ sandboxState: rootState }));

    expect(ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        ownsSandbox: true,
        sessionId: "root-session",
        state: rootState,
      }),
    );
  });

  it("treats an explicit null parent state as an empty owner state", async () => {
    const ctx = new ContextContainer();
    const registry: RuntimeSandboxRegistry = createStubSandboxRegistry();
    const staleChildState = {
      session: {
        providerName: "test",
        state: { sandboxName: "stale-child" },
        stateProtocolVersion: 1,
      },
    };

    ctx.set(BundleKey, createBundle({ agentName: "weather-agent", registry }));
    ctx.set(ChannelKey, {
      kind: "subagent",
      state: { parentSandboxState: null, sandboxSessionId: "root-sandbox-session" },
    });
    ctx.set(SessionIdKey, "child-session");

    await sandboxProvider.create(ctx, createHarnessSession({ sandboxState: staleChildState }));

    expect(ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        ownsSandbox: false,
        sessionId: "root-sandbox-session",
        state: null,
      }),
    );
  });

  it("uses explicit sharing metadata for self-delegation even without inheritsParent", async () => {
    const ctx = new ContextContainer();
    const registry: RuntimeSandboxRegistry = createStubSandboxRegistry();
    const parentSandboxState = { initialized: true, session: null };

    ctx.set(BundleKey, createBundle({ agentName: "weather-agent", registry }));
    ctx.set(ChannelKey, {
      kind: "subagent",
      state: { parentSandboxState, sandboxSessionId: "root-sandbox-session" },
    });
    ctx.set(SessionIdKey, "self-child-session");

    await sandboxProvider.create(ctx, createHarnessSession());

    expect(ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        ownsSandbox: false,
        sessionId: "root-sandbox-session",
        state: parentSandboxState,
      }),
    );
  });

  it("passes the owning session identity to sandbox access", async () => {
    const ctx = new ContextContainer();
    const registry: RuntimeSandboxRegistry = createStubSandboxRegistry();

    ctx.set(BundleKey, createBundle({ agentName: "weather-agent", registry }));
    ctx.set(ChannelKey, { kind: "slack" });
    ctx.set(SessionIdKey, "session_1");

    await sandboxProvider.create(ctx, createHarnessSession());

    expect(ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        ownsSandbox: true,
        sessionId: "session_1",
      }),
    );
  });
});
