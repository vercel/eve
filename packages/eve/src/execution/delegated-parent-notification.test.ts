import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  readDurableSession,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { notifyDelegatedParentStep } from "#execution/delegated-parent-notification.js";
import { SUBAGENT_ADAPTER, SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";

vi.mock("./durable-session-store.js", () => ({
  readDurableSession: vi.fn(),
}));

vi.mock("../runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));

const readDurableSessionMock = vi.mocked(readDurableSession);
const resumeHookMock = vi.mocked(resumeHook);

const TURN_USAGE_STATE_KEY = "eve.harness.turnUsage";
const SESSION_STATE = { sessionId: "child-session" } as DurableSessionState;

function createSuccessResult(): RuntimeSubagentResultActionResult {
  return {
    callId: "call-1",
    kind: "subagent-result",
    output: "done",
    subagentName: "research",
  };
}

function durableSessionWithState(state: DurableSession["state"]): DurableSession {
  return {
    agent: { system: "" },
    continuationToken: "child-tok",
    history: [],
    sessionId: "child-session",
    state,
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
    readDurableSessionMock.mockReset();
    resumeHookMock.mockReset();
    resumeHookMock.mockResolvedValue(undefined as never);
  });

  it("attaches the completed child's session-total usage to a success result", async () => {
    // Flat fields are the *final turn's* usage; `session` carries the
    // session-lifetime totals. The notification must report the latter.
    readDurableSessionMock.mockResolvedValue(
      durableSessionWithState({
        [TURN_USAGE_STATE_KEY]: {
          turnId: "turn_1",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          session: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
          },
        },
      }),
    );

    await notifyDelegatedParentStep({
      result: createSuccessResult(),
      serializedContext: createSerializedContext(),
      sessionState: SESSION_STATE,
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          output: "done",
          subagentName: "research",
          usage: { cacheReadTokens: 10, inputTokens: 100, outputTokens: 50 },
        },
      ],
    });
  });

  it("omits usage when the completed session reports none", async () => {
    readDurableSessionMock.mockResolvedValue(durableSessionWithState({}));

    await notifyDelegatedParentStep({
      result: createSuccessResult(),
      serializedContext: createSerializedContext(),
      sessionState: SESSION_STATE,
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [createSuccessResult()],
    });
  });

  it("omits usage on error results without reading the session", async () => {
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
      sessionState: SESSION_STATE,
    });

    expect(readDurableSessionMock).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [errorResult],
    });
  });

  it("still notifies the parent when the usage read fails", async () => {
    readDurableSessionMock.mockRejectedValue(new Error("snapshot unavailable"));

    await notifyDelegatedParentStep({
      result: createSuccessResult(),
      serializedContext: createSerializedContext(),
      sessionState: SESSION_STATE,
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [createSuccessResult()],
    });
  });

  it("omits usage when no session state is provided", async () => {
    await notifyDelegatedParentStep({
      result: createSuccessResult(),
      serializedContext: createSerializedContext(),
    });

    expect(readDurableSessionMock).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [createSuccessResult()],
    });
  });
});
