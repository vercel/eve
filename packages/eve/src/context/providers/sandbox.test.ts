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

function createHarnessSession(): HarnessSession {
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
    });
  });

  it("tags sandbox backend resources with agent, channel, and session id", async () => {
    const ctx = new ContextContainer();
    const registry: RuntimeSandboxRegistry = createStubSandboxRegistry();

    ctx.set(BundleKey, createBundle({ agentName: "weather-agent", registry }));
    ctx.set(ChannelKey, { kind: "slack" });
    ctx.set(SessionIdKey, "session_1");

    await sandboxProvider.create(ctx, createHarnessSession());

    expect(ensureSandboxAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: {
          agent: "weather-agent",
          channel: "slack",
          sessionId: "session_1",
        },
      }),
    );
  });
});
