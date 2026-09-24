import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  bindTurnCallerContextStep,
  notifyTurnCallerStep,
  reportTaskStartedStep,
  resolveInitialTurnCallerStep,
} from "#tasks/child.js";
import { SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { recordTaskReport } from "#subagents/remote/task-reports.js";

vi.mock("../runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));
vi.mock("#subagents/remote/task-reports.js", () => ({ recordTaskReport: vi.fn() }));

const resumeHookMock = vi.mocked(resumeHook);
const fetchMock = vi.fn();

const USAGE = { cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 50 };
const ZERO_USAGE = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };

function createSerializedContext(
  adapterState: Record<string, unknown> = {},
): Record<string, unknown> {
  const bundle = {
    adapterRegistry: {
      adaptersByKind: new Map([[SUBAGENT_ADAPTER_KIND, { kind: SUBAGENT_ADAPTER_KIND }]]),
    },
    compiledArtifactsSource: { kind: "test" },
    nodeId: undefined,
  } as never;
  vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);

  const ctx = new ContextContainer();
  ctx.set(BundleKey, bundle);
  ctx.set(SessionIdKey, "child-session");
  ctx.set(ChannelKey, {
    kind: SUBAGENT_ADAPTER_KIND,
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
      code: "EXECUTION_FAILED",
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

    const error = { code: "EXECUTION_FAILED", message: "session owner crashed" };
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
      settled: { answer: 4, output: "remote answer" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://caller.example/eve/v1/callback/parent-turn",
      expect.objectContaining({ method: "POST" }),
    );
    const body: unknown = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body).toEqual({
      answer: 4,
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
      taskProtocol: 1,
    });
    expect(resumeHookMock).not.toHaveBeenCalled();
    // Recorded before it is sent, so a caller whose callback is lost can read it at its
    // deadline, and only with the callback token it was sent to.
    expect(recordTaskReport).toHaveBeenCalledExactlyOnceWith({
      callbackToken: "parent-turn",
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
        code: "EXECUTION_FAILED",
        message: "remote failed",
      },
      kind: "turn.failed",
      outcome: {
        kind: "terminal",
        result: {
          error: { code: "EXECUTION_FAILED", message: "remote failed" },
          kind: "failed",
        },
        usageDelta: USAGE,
      },
      sessionId: "remote-session",
      subagentName: "remote",
      taskProtocol: 1,
    });
  });

  it("stops retrying a result the caller refuses for its task protocol version", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { code: "TASK_PROTOCOL_MISMATCH", ok: false, taskProtocol: 2 },
        { status: 409 },
      ),
    );

    await expect(
      notifyTurnCallerStep({
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
        settled: { answer: 4, output: "remote answer" },
      }),
    ).resolves.toBeUndefined();
    errorSpy.mockRestore();
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

  const child = {
    continuationToken: "subagent:parent:research-abc234",
    sessionId: "child-session",
  };
  const OWNER_INBOX = "eve:inbox:v1:eve:session:parent:inbox";

  it("resolves the caller and reports the child's address to the owner inbox in one step", async () => {
    resumeHookMock.mockResolvedValue(undefined as never);

    await expect(
      reportTaskStartedStep({
        child,
        serializedContext: createSerializedContext({ parentContinuationToken: OWNER_INBOX }),
      }),
    ).resolves.toEqual({
      caller: {
        callId: "call-1",
        replyTo: { kind: "hook", token: OWNER_INBOX },
        subagentName: "research",
      },
      ownerGone: false,
    });

    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(OWNER_INBOX, {
      callId: "call-1",
      child,
      kind: "task.started",
    });
  });

  it("reports nothing for a remote owner, which learns the address from its create response", async () => {
    const result = await reportTaskStartedStep({
      child,
      serializedContext: {
        [SessionCallbackKey.name]: {
          callId: "call-1",
          subagentName: "research",
          token: "reply-token",
          url: "https://parent.example/eve/v1/callback/reply-token",
        },
      },
    });

    expect(result).toMatchObject({ caller: { replyTo: { kind: "callback" } }, ownerGone: false });
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("tells the child to exit when its owner no longer exists", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resumeHookMock.mockRejectedValue(new HookNotFoundError(OWNER_INBOX));

    try {
      await expect(
        reportTaskStartedStep({
          child,
          serializedContext: createSerializedContext({ parentContinuationToken: OWNER_INBOX }),
        }),
      ).resolves.toMatchObject({ ownerGone: true });
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

    await expect(
      reportTaskStartedStep({
        child,
        serializedContext: createSerializedContext({ parentContinuationToken: OWNER_INBOX }),
      }),
    ).rejects.toBe(failure);
  });
});
