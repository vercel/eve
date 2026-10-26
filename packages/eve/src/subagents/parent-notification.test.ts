import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  bindTurnCallerContext,
  NOT_PENDING_RETRY_DELAYS_MS,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";
import { SUBAGENT_ADAPTER } from "#subagents/adapter.js";
import { SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeHook } from "#internal/workflow/runtime.js";

vi.mock("../runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));

const resumeHookMock = vi.mocked(resumeHook);
const fetchMock = vi.fn();

const USAGE = { cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 50 };
const ZERO_USAGE = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };

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

describe("turn caller notification", () => {
  beforeEach(() => {
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

  describe("a remote caller that reports nothing pending", () => {
    const remoteCaller = () =>
      resolveInitialTurnCallerStep({
        serializedContext: {
          "eve.sessionCallback": {
            callId: "call-remote",
            subagentName: "remote",
            token: "parent-turn",
            url: "https://caller.example/eve/v1/callback/parent-turn",
          },
          "eve.sessionId": "remote-session",
        },
      });
    const notPending = () =>
      Response.json(
        { code: "CALLBACK_NOT_PENDING", error: "Session callback not pending.", ok: false },
        { status: 404 },
      );
    const notify = async () =>
      notifyTurnCallerStep({
        caller: await remoteCaller(),
        lifecycle: "parked",
        sessionId: "remote-session",
        settled: { output: "remote answer" },
      });

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("delivers the result once the caller registers the reply it sent", async () => {
      fetchMock
        .mockResolvedValueOnce(notPending())
        .mockResolvedValueOnce(notPending())
        .mockResolvedValueOnce(new Response(null, { status: 202 }));
      const notified = notify();
      await vi.runAllTimersAsync();
      await expect(notified).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("leaves the session alive when the caller already took the result or stopped waiting", async () => {
      // A delivery whose 202 was lost: the caller applied it, so its repeat finds nothing pending.
      fetchMock.mockImplementation(async () => notPending());
      const notified = notify();
      await vi.runAllTimersAsync();
      await expect(notified).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(NOT_PENDING_RETRY_DELAYS_MS.length + 1);
    });

    it("also reads an earlier protocol's not-pending answer, which names no code", async () => {
      fetchMock.mockImplementation(async () =>
        Response.json({ error: "Session callback not pending.", ok: false }, { status: 404 }),
      );
      const notified = notify();
      await vi.runAllTimersAsync();
      await expect(notified).resolves.toBeUndefined();
    });

    it("still fails a callback that can't be delivered, so its step retries", async () => {
      for (const response of [
        new Response("Not Found", { status: 404 }),
        new Response(null, { status: 503 }),
      ]) {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(response);
        await expect(notify()).rejects.toThrow(/Turn callback failed with HTTP (404|503)/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
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
  it("rebinds local adapter forwarding to a continuation caller", () => {
    expect(
      bindTurnCallerContext(
        {
          callId: "call-new",
          replyTo: { kind: "hook", token: "turn-new" },
          subagentName: "research",
        },
        {
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
      ),
    ).toEqual({
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

  it("rebinds remote callback forwarding to a continuation caller", () => {
    expect(
      bindTurnCallerContext(
        {
          callId: "call-new",
          replyTo: {
            kind: "callback",
            token: "turn-new",
            url: "https://parent.example/eve/v1/callback/turn-new",
          },
          subagentName: "research",
        },
        {},
      ),
    ).toEqual({
      [SessionCallbackKey.name]: {
        callId: "call-new",
        subagentName: "research",
        token: "turn-new",
        url: "https://parent.example/eve/v1/callback/turn-new",
      },
    });
  });
});
