import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { notifyDelegatedParentStep } from "#execution/delegated-parent-notification.js";
import { SUBAGENT_ADAPTER, SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";

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

function createSerializedContext(): Record<string, unknown> {
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
    },
  });
  return serializeContext(ctx);
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
});
