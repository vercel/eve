import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { notifyDelegatedParentStep } from "#execution/delegated-parent-notification.js";
import { SUBAGENT_ADAPTER, SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import type { HarnessSession } from "#harness/types.js";

vi.mock("../runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));

const resumeHookMock = vi.mocked(resumeHook);

const USAGE = { cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 50 };

function createSuccessResult(): RuntimeSubagentResultActionResult {
  return {
    callId: "call-1",
    kind: "subagent-result",
    output: "done",
    subagentName: "research",
  };
}

function createSerializedContext(
  adapterState: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const bundle = {
    adapterRegistry: {
      adaptersByKind: new Map([[SUBAGENT_ADAPTER_KIND, SUBAGENT_ADAPTER]]),
    },
    compiledArtifactsSource: { kind: "test" },
    nodeId: undefined,
  } as never;
  vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);

  const ctx = new ContextContainer();
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, {
    ...SUBAGENT_ADAPTER,
    state: {
      callId: "call-1",
      parentContinuationToken: "parent-tok",
      parentSessionId: "parent-session",
      subagentName: "research",
      ...adapterState,
    },
  });
  return serializeContext(ctx);
}

function createSessionState(overrides: Partial<HarnessSession> = {}) {
  return createDurableSessionState({
    session: {
      agent: {
        modelReference: { id: "test-model" },
        system: "",
        tools: [],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "child-token",
      history: [],
      sessionId: "child-session",
      ...overrides,
    },
  });
}

describe("notifyDelegatedParentStep", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
    resumeHookMock.mockResolvedValue(undefined as never);
  });

  it("attaches usage to a success result", async () => {
    await notifyDelegatedParentStep({
      result: createSuccessResult(),
      serializedContext: createSerializedContext(),
      usage: USAGE,
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          output: "done",
          subagentName: "research",
          usage: USAGE,
        },
      ],
    });
  });

  it("omits usage when none is provided", async () => {
    await notifyDelegatedParentStep({
      result: createSuccessResult(),
      serializedContext: createSerializedContext(),
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [createSuccessResult()],
    });
  });

  it("never attaches usage to error results", async () => {
    const errorResult: RuntimeSubagentResultActionResult = {
      callId: "call-1",
      isError: true,
      kind: "subagent-result",
      output: { code: "SUBAGENT_EXECUTION_FAILED", message: "boom" },
      subagentName: "research",
    };

    await notifyDelegatedParentStep({
      result: errorResult,
      serializedContext: createSerializedContext(),
      usage: USAGE,
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [errorResult],
    });
  });

  it("attaches inherited sandbox state captured by the child session", async () => {
    const sandboxState = {
      initialized: true,
      session: {
        backendName: "test-sandbox",
        metadata: { workspace: "repo" },
        sessionKey: "sandbox-session-key",
      },
    };

    await notifyDelegatedParentStep({
      result: createSuccessResult(),
      serializedContext: createSerializedContext({
        sandboxNodeId: "__root__",
        sandboxSessionId: "parent-session",
      }),
      sessionState: createSessionState({ sandboxState }),
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          inheritedSandbox: {
            nodeId: "__root__",
            sessionId: "parent-session",
            state: sandboxState,
          },
          kind: "subagent-result",
          output: "done",
          subagentName: "research",
        },
      ],
    });
  });

  it("preserves inherited sandbox state when the child fails", async () => {
    const sandboxState = {
      initialized: true,
      session: {
        backendName: "test-sandbox",
        metadata: { workspace: "repo" },
        sessionKey: "sandbox-session-key",
      },
    };
    const errorResult: RuntimeSubagentResultActionResult = {
      callId: "call-1",
      isError: true,
      kind: "subagent-result",
      output: { code: "SUBAGENT_EXECUTION_FAILED", message: "boom" },
      subagentName: "research",
    };

    await notifyDelegatedParentStep({
      result: errorResult,
      serializedContext: createSerializedContext({
        sandboxNodeId: "__root__",
        sandboxSessionId: "parent-session",
      }),
      sessionState: createSessionState({ sandboxState }),
      usage: USAGE,
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [
        {
          ...errorResult,
          inheritedSandbox: {
            nodeId: "__root__",
            sessionId: "parent-session",
            state: sandboxState,
          },
        },
      ],
    });
  });
});
