import { beforeEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { ContextContainer } from "#context/container.js";
import { SessionCallbackKey, UnsentCallerEventsKey } from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import { flushUnsentCallerEventsStep } from "#subagents/remote/unsent-caller-events-step.js";
import { forwardTaskInputToCaller } from "#tasks/input-forward.js";

vi.mock("#execution/session-callback-request.js", () => ({
  postSessionCallbackRequest: vi.fn(),
}));
vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: vi.fn() }));

const CALLBACK = {
  callId: "call-1",
  subagentName: "billing",
  token: "owner-alias",
  url: "https://owner.example/eve/v1/callback/owner-alias",
};
const INPUT_REQUESTED = {
  data: {
    requests: [
      {
        action: { callId: "tool-1", input: {}, kind: "tool-call", toolName: "refund" },
        kind: "tool-approval",
        prompt: "Approve the refund for order 42?",
        requestId: "req-1",
      },
    ],
    sequence: 3,
    stepIndex: 1,
    turnId: "turn_0",
  },
  type: "input.requested",
} as UnstampedMessageStreamEvent;
const INPUT_BODY = {
  callId: "call-1",
  event: INPUT_REQUESTED,
  kind: "task.input",
  sessionId: "child-1",
  subagentName: "billing",
  taskProtocol: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(postSessionCallbackRequest).mockResolvedValue(new Response(null, { status: 202 }));
});

function localChild(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(ChannelKey, {
    kind: SUBAGENT_ADAPTER_KIND,
    state: {
      callId: "call-1",
      parentContinuationToken: "eve:inbox:v1:eve:session:owner:inbox",
      parentSessionId: "owner",
      subagentName: "billing",
    },
  });
  return ctx;
}

function remoteChild(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(ChannelKey, { kind: "http" });
  ctx.set(SessionCallbackKey, CALLBACK);
  return ctx;
}

describe("forwardTaskInputToCaller", () => {
  it("sends a local child's input event to its owner's inbox", async () => {
    await forwardTaskInputToCaller({
      ctx: localChild(),
      event: INPUT_REQUESTED,
      sessionId: "child-1",
    });

    expect(resumeHook).toHaveBeenCalledExactlyOnceWith("eve:inbox:v1:eve:session:owner:inbox", {
      callId: "call-1",
      childSessionId: "child-1",
      event: INPUT_REQUESTED,
      kind: "task.input",
      subagentName: "billing",
    });
    expect(postSessionCallbackRequest).not.toHaveBeenCalled();
  });

  it("drops a local child's event when its owner is gone, and fails on anything else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(resumeHook).mockRejectedValueOnce(new HookNotFoundError("owner"));
    await expect(
      forwardTaskInputToCaller({ ctx: localChild(), event: INPUT_REQUESTED, sessionId: "child-1" }),
    ).resolves.toBeUndefined();

    vi.mocked(resumeHook).mockRejectedValueOnce(new Error("world unavailable"));
    await expect(
      forwardTaskInputToCaller({ ctx: localChild(), event: INPUT_REQUESTED, sessionId: "child-1" }),
    ).rejects.toThrow("world unavailable");
    warn.mockRestore();
  });

  it("posts a remote child's input event to its caller's callback", async () => {
    const ctx = remoteChild();

    await forwardTaskInputToCaller({ ctx, event: INPUT_REQUESTED, sessionId: "child-1" });

    expect(postSessionCallbackRequest).toHaveBeenCalledExactlyOnceWith({
      body: INPUT_BODY,
      logFailures: false,
      url: CALLBACK.url,
    });
    expect(resumeHook).not.toHaveBeenCalled();
    expect(ctx.get(UnsentCallerEventsKey)).toBeUndefined();
  });

  it("forwards nothing from a session no caller started, or for other events", async () => {
    await forwardTaskInputToCaller({
      ctx: new ContextContainer(),
      event: INPUT_REQUESTED,
      sessionId: "root",
    });
    for (const ctx of [localChild(), remoteChild()]) {
      await forwardTaskInputToCaller({
        ctx,
        event: { data: { sequence: 3, turnId: "turn_0" }, type: "turn.completed" },
        sessionId: "child-1",
      });
    }

    expect(resumeHook).not.toHaveBeenCalled();
    expect(postSessionCallbackRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["a network failure", () => Promise.reject(new Error("network down"))],
    [
      "the caller's retry while its session moves",
      () => Promise.resolve(new Response(null, { status: 503 })),
    ],
  ])("keeps a remote event to send again after %s", async (_label, respond) => {
    vi.mocked(postSessionCallbackRequest).mockImplementationOnce(respond);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = remoteChild();

    await forwardTaskInputToCaller({ ctx, event: INPUT_REQUESTED, sessionId: "child-1" });

    expect(ctx.get(UnsentCallerEventsKey)).toEqual([{ body: INPUT_BODY, url: CALLBACK.url }]);
    warn.mockRestore();
  });

  it("queues a later event behind one still unsent, so the caller sees them in order", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = remoteChild();
    ctx.set(UnsentCallerEventsKey, [{ body: INPUT_BODY, url: CALLBACK.url }]);

    await forwardTaskInputToCaller({ ctx, event: INPUT_REQUESTED, sessionId: "child-1" });

    expect(postSessionCallbackRequest).not.toHaveBeenCalled();
    expect(ctx.get(UnsentCallerEventsKey)).toHaveLength(2);
    warn.mockRestore();
  });

  it("drops an event the caller can never take", async () => {
    vi.mocked(postSessionCallbackRequest).mockResolvedValueOnce(
      Response.json({ code: "TASK_PROTOCOL_MISMATCH", ok: false }, { status: 409 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = remoteChild();

    await forwardTaskInputToCaller({ ctx, event: INPUT_REQUESTED, sessionId: "child-1" });

    expect(ctx.get(UnsentCallerEventsKey)).toBeUndefined();
    warn.mockRestore();
  });
});

describe("flushUnsentCallerEventsStep", () => {
  const serializedContext = {
    "eve.sessionId": "child-1",
    [UnsentCallerEventsKey.name]: [{ body: INPUT_BODY, url: CALLBACK.url }],
  };

  it("sends the owed events in order and clears them", async () => {
    await expect(flushUnsentCallerEventsStep({ serializedContext })).resolves.toEqual({
      "eve.sessionId": "child-1",
    });
    expect(postSessionCallbackRequest).toHaveBeenCalledExactlyOnceWith({
      body: INPUT_BODY,
      logFailures: true,
      url: CALLBACK.url,
    });
  });

  it("throws on a failure that may clear, so the workflow retries the step", async () => {
    vi.mocked(postSessionCallbackRequest).mockResolvedValueOnce(
      new Response(null, { headers: { "retry-after": "1" }, status: 503 }),
    );

    await expect(flushUnsentCallerEventsStep({ serializedContext })).rejects.toThrow(
      "did not take an input request",
    );
  });
});
