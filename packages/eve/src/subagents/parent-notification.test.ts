import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  bindTurnCallerContextStep,
  notifyDelegatedParentStep,
  notifyTurnCallerStep,
  reportTaskStartedStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";
import { SUBAGENT_ADAPTER } from "#subagents/adapter.js";
import { SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { recordTaskReport } from "#subagents/task-reports.js";

vi.mock("../runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));
vi.mock("#subagents/task-reports.js", () => ({ recordTaskReport: vi.fn() }));

const resumeHookMock = vi.mocked(resumeHook);
const fetchMock = vi.fn();

const USAGE = { cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 50 };
const ZERO_USAGE = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };

function createSuccessResult(): RuntimeSubagentChildResult {
  return {
    callId: "call-1",
    kind: "subagent-result",
    origin: "child",
    outcome: {
      kind: "terminal",
      result: { kind: "succeeded", output: "done" },
      usageDelta: ZERO_USAGE,
    },
    output: "done",
    subagentName: "research",
  };
}

function createSerializedContext(
  adapterState: Record<string, unknown> = {},
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
  ctx.set(SessionIdKey, "child-session");
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

describe("notifyDelegatedParentStep", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
    resumeHookMock.mockResolvedValue(undefined as never);
  });

  it("attaches usage to a success result and folds it into the outcome delta", async () => {
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
          origin: "child",
          outcome: {
            kind: "terminal",
            result: { kind: "succeeded", output: "done" },
            usageDelta: USAGE,
          },
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

  it("attaches usage to error results", async () => {
    const errorResult: RuntimeSubagentChildResult = {
      callId: "call-1",
      isError: true,
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: "terminal",
        result: {
          error: { code: "SUBAGENT_EXECUTION_FAILED", message: "boom" },
          kind: "failed",
        },
        usageDelta: ZERO_USAGE,
      },
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
      results: [
        {
          ...errorResult,
          outcome: { ...errorResult.outcome, usageDelta: USAGE },
          usage: USAGE,
        },
      ],
    });
  });
});

describe("turn caller notification", () => {
  beforeEach(() => {
    vi.mocked(recordTaskReport).mockReset();
    resumeHookMock.mockReset();
    resumeHookMock.mockResolvedValue(undefined as never);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op when the conversation has no turn caller", async () => {
    const serializedContext = { "eve.sessionId": "root-session" };
    const caller = await resolveInitialTurnCallerStep({ serializedContext });

    expect(caller).toBeUndefined();
    await expect(
      notifyTurnCallerStep({
        caller,
        lifecycle: "parked",
        sessionId: "root-session",
        settled: { output: "root answer" },
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("restores the caller from a local adapter with an opaque reply hook", async () => {
    const caller = await resolveInitialTurnCallerStep({
      serializedContext: createSerializedContext({
        parentContinuationToken: "invocation-reply-hook",
      }),
    });

    expect(caller).toEqual({
      callId: "call-1",
      replyTo: { kind: "hook", token: "invocation-reply-hook" },
      subagentName: "research",
    });
  });

  it("uses the adapter state for the child's first settled turn", async () => {
    const serializedContext = createSerializedContext();
    const caller = await resolveInitialTurnCallerStep({ serializedContext });
    await notifyTurnCallerStep({
      caller,
      lifecycle: "parked",
      sessionId: "child-session",
      settled: { output: "first answer", usage: USAGE },
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "parked",
            result: { kind: "succeeded", output: "first answer" },
            usageDelta: USAGE,
          },
          output: "first answer",
          subagentName: "research",
          usage: USAGE,
        },
      ],
    });
  });

  it("reports how many steering messages reached the answer", async () => {
    await notifyTurnCallerStep({
      caller: {
        callId: "call-2",
        replyTo: { kind: "hook", token: "parent-turn-2" },
        subagentName: "research",
      },
      lifecycle: "parked",
      sessionId: "child-session",
      settled: { output: "draft with pricing", steers: 2 },
    });

    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith("parent-turn-2", {
      kind: "runtime-action-result",
      results: [expect.objectContaining({ callId: "call-2", steers: 2 })],
    });
  });

  it("notifies the caller of a continued turn with a zero usage delta", async () => {
    await notifyTurnCallerStep({
      caller: {
        callId: "call-2",
        replyTo: { kind: "hook", token: "parent-turn-2" },
        subagentName: "research",
      },
      lifecycle: "parked",
      sessionId: "child-session",
      settled: { output: "follow-up answer" },
    });

    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith("parent-turn-2", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-2",
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "parked",
            result: { kind: "succeeded", output: "follow-up answer" },
            usageDelta: ZERO_USAGE,
          },
          output: "follow-up answer",
          subagentName: "research",
        },
      ],
    });
  });

  it("reports a parked failure as a parked outcome carrying the usage delta", async () => {
    await notifyTurnCallerStep({
      caller: {
        callId: "call-2",
        replyTo: { kind: "hook", token: "parent-turn-2" },
        subagentName: "research",
      },
      lifecycle: "parked",
      sessionId: "child-session",
      settled: {
        isError: true,
        output: "The agent could not produce a result matching the requested schema.",
        usage: USAGE,
      },
    });

    const error = {
      code: "SUBAGENT_EXECUTION_FAILED",
      message: "The agent could not produce a result matching the requested schema.",
    };
    expect(resumeHookMock).toHaveBeenCalledWith("parent-turn-2", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-2",
          isError: true,
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "parked",
            result: { error, kind: "failed" },
            usageDelta: USAGE,
          },
          output: error,
          subagentName: "research",
        },
      ],
    });
  });

  it("marks a crash-path notification terminal", async () => {
    await notifyTurnCallerStep({
      caller: {
        callId: "call-3",
        replyTo: { kind: "hook", token: "parent-turn-3" },
        subagentName: "research",
      },
      lifecycle: "terminal",
      sessionId: "child-session",
      settled: { isError: true, output: new Error("session owner crashed") },
    });

    const error = { code: "SUBAGENT_EXECUTION_FAILED", message: "session owner crashed" };
    expect(resumeHookMock).toHaveBeenCalledWith("parent-turn-3", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-3",
          isError: true,
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "terminal",
            result: { error, kind: "failed" },
            usageDelta: ZERO_USAGE,
          },
          output: error,
          subagentName: "research",
        },
      ],
    });
  });

  it("posts a settled turn with its outcome to the remote callback", async () => {
    const serializedContext = {
      "eve.sessionCallback": {
        callId: "call-remote",
        subagentName: "remote",
        token: "parent-turn",
        url: "https://caller.example/eve/v1/callback/parent-turn",
      },
      "eve.sessionId": "remote-session",
    };
    const caller = await resolveInitialTurnCallerStep({ serializedContext });
    await notifyTurnCallerStep({
      caller,
      lifecycle: "parked",
      sessionId: "remote-session",
      settled: { output: "remote answer" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://caller.example/eve/v1/callback/parent-turn",
      expect.objectContaining({ method: "POST" }),
    );
    const body: unknown = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body).toEqual({
      callId: "call-remote",
      kind: "turn.completed",
      outcome: {
        kind: "parked",
        result: { kind: "succeeded", output: "remote answer" },
        usageDelta: ZERO_USAGE,
      },
      output: "remote answer",
      sessionId: "remote-session",
      subagentName: "remote",
    });
    expect(resumeHookMock).not.toHaveBeenCalled();
    // Recorded before it is sent, so a caller whose callback is lost can read it at its deadline.
    expect(recordTaskReport).toHaveBeenCalledExactlyOnceWith({
      report: body,
      sessionId: "remote-session",
    });
  });

  it("reports the steering messages a remote caller's call received", async () => {
    await notifyTurnCallerStep({
      caller: {
        callId: "call-remote",
        replyTo: {
          kind: "callback",
          token: "parent-turn",
          url: "https://caller.example/eve/v1/callback/parent-turn",
        },
        subagentName: "remote",
      },
      lifecycle: "parked",
      sessionId: "remote-session",
      settled: { output: "revised answer", steers: 2 },
    });

    const body: unknown = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body).toMatchObject({ callId: "call-remote", kind: "turn.completed", steers: 2 });
  });

  it("posts a failed turn with its outcome to a remote callback", async () => {
    await notifyTurnCallerStep({
      caller: {
        callId: "call-remote",
        replyTo: {
          kind: "callback",
          token: "parent-turn",
          url: "https://caller.example/eve/v1/callback/parent-turn",
        },
        subagentName: "remote",
      },
      lifecycle: "terminal",
      sessionId: "remote-session",
      settled: { isError: true, output: new Error("remote failed"), usage: USAGE },
    });

    const body: unknown = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body).toEqual({
      callId: "call-remote",
      error: {
        code: "SUBAGENT_EXECUTION_FAILED",
        message: "remote failed",
      },
      kind: "turn.failed",
      outcome: {
        kind: "terminal",
        result: {
          error: { code: "SUBAGENT_EXECUTION_FAILED", message: "remote failed" },
          kind: "failed",
        },
        usageDelta: USAGE,
      },
      sessionId: "remote-session",
      subagentName: "remote",
    });
  });

  it("warns and returns when the caller hook no longer exists", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resumeHookMock.mockRejectedValue(new HookNotFoundError("parent-tok"));

    try {
      await expect(
        notifyTurnCallerStep({
          caller: {
            callId: "call-1",
            replyTo: { kind: "hook", token: "parent-tok" },
            subagentName: "research",
          },
          lifecycle: "parked",
          sessionId: "child-session",
          settled: { output: "late answer" },
        }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        "[eve:execution.delegated-parent-notification] turn caller hook no longer exists",
        expect.objectContaining({
          callId: "call-1",
          callerToken: "parent-tok",
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("turn caller binding", () => {
  it("rebinds local adapter forwarding to a continuation caller", async () => {
    await expect(
      bindTurnCallerContextStep({
        caller: {
          callId: "call-new",
          replyTo: { kind: "hook", token: "turn-new" },
          subagentName: "research",
        },
        serializedContext: {
          [ChannelKey.name]: {
            kind: SUBAGENT_ADAPTER_KIND,
            state: {
              callId: "call-old",
              parentContinuationToken: "turn-old",
              parentSessionId: "parent",
              subagentName: "research",
            },
          },
        },
      }),
    ).resolves.toEqual({
      [ChannelKey.name]: {
        kind: SUBAGENT_ADAPTER_KIND,
        state: {
          callId: "call-new",
          parentContinuationToken: "turn-new",
          parentSessionId: "parent",
          subagentName: "research",
        },
      },
    });
  });

  it("rebinds remote callback forwarding to a non-task continuation caller", async () => {
    await expect(
      bindTurnCallerContextStep({
        caller: {
          callId: "call-new",
          replyTo: {
            kind: "callback",
            token: "turn-new",
            url: "https://parent.example/eve/v1/callback/turn-new",
          },
          subagentName: "research",
        },
        serializedContext: {},
      }),
    ).resolves.toEqual({
      [SessionCallbackKey.name]: {
        callId: "call-new",
        subagentName: "research",
        token: "turn-new",
        url: "https://parent.example/eve/v1/callback/turn-new",
      },
    });
  });

  it("rebinds local adapter forwarding to the current caller", async () => {
    const serializedContext = {
      [ChannelKey.name]: {
        kind: SUBAGENT_ADAPTER_KIND,
        state: {
          callId: "call-old",
          parentContinuationToken: "reply-old",
          parentSessionId: "parent",
          subagentName: "research",
        },
      },
    };

    await expect(
      bindTurnCallerContextStep({
        caller: {
          callId: "call-new",
          replyTo: { kind: "hook", token: "reply-new" },
          subagentName: "research",
        },
        serializedContext,
      }),
    ).resolves.toMatchObject({
      [ChannelKey.name]: {
        state: { callId: "call-new", parentContinuationToken: "reply-new" },
      },
    });
  });

  it("rebinds remote callback forwarding to the current caller", async () => {
    await expect(
      bindTurnCallerContextStep({
        caller: {
          callId: "call-new",
          replyTo: {
            kind: "callback",
            token: "reply-new",
            url: "https://parent.example/eve/v1/callback/reply-new",
          },
          subagentName: "research",
        },
        serializedContext: {},
      }),
    ).resolves.toEqual({
      [SessionCallbackKey.name]: {
        callId: "call-new",
        subagentName: "research",
        token: "reply-new",
        url: "https://parent.example/eve/v1/callback/reply-new",
      },
    });
  });
});

describe("reportTaskStartedStep", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
  });

  const input = {
    callId: "call-1",
    child: { continuationToken: "subagent:parent:research-abc234", sessionId: "child-session" },
    token: "eve:inbox:v1:eve:session:parent:inbox",
  };

  it("reports the child's address to the owner inbox", async () => {
    resumeHookMock.mockResolvedValue(undefined as never);

    await expect(reportTaskStartedStep(input)).resolves.toBe(true);

    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(input.token, {
      callId: "call-1",
      child: input.child,
      kind: "task.started",
    });
  });

  it("tells the child to exit when its owner no longer exists", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resumeHookMock.mockRejectedValue(new HookNotFoundError(input.token));

    try {
      await expect(reportTaskStartedStep(input)).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        "[eve:execution.delegated-parent-notification] task owner no longer exists; the child exits",
        expect.objectContaining({ callId: "call-1" }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("lets any other failure retry the step", async () => {
    const failure = new Error("queue unavailable");
    resumeHookMock.mockRejectedValue(failure);

    await expect(reportTaskStartedStep(input)).rejects.toBe(failure);
  });
});
