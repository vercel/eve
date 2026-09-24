import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SessionCallbackKey, UnsentCallerEventsKey } from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import {
  createAuthorizationRequiredEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { forwardEventToRemoteCaller } from "#subagents/remote/caller-events.js";
import { flushUnsentCallerEventsStep } from "#subagents/remote/unsent-caller-events-step.js";

vi.mock("#execution/session-callback-request.js", () => ({
  postSessionCallbackRequest: vi.fn(),
}));

const CALLBACK = {
  callId: "call-1",
  subagentName: "billing",
  token: "owner-alias",
  url: "https://owner.example/eve/v1/callback/owner-alias",
};
const REQUESTS = [
  {
    action: { callId: "tool-1", input: {}, kind: "tool-call" as const, toolName: "refund" },
    kind: "tool-approval" as const,
    prompt: "Approve the refund for order 42?",
    requestId: "req-1",
  },
];
const INPUT_REQUESTED = {
  data: { requests: REQUESTS, sequence: 3, stepIndex: 1, turnId: "turn_0" },
  type: "input.requested",
} as UnstampedMessageStreamEvent;
const INPUT_BODY = {
  callId: "call-1",
  event: { requests: REQUESTS, sequence: 3, stepIndex: 1, turnId: "turn_0" },
  kind: "input.requested",
  sessionId: "remote-1",
  subagentName: "billing",
  taskProtocol: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(postSessionCallbackRequest).mockResolvedValue(new Response(null, { status: 202 }));
});

describe("forwardEventToRemoteCaller", () => {
  it("posts an input request to the caller's callback, without a descendant's task id", async () => {
    const ctx = contextWith(CALLBACK);

    await forwardEventToRemoteCaller({
      ctx,
      event: {
        data: {
          requests: REQUESTS,
          sequence: 3,
          stepIndex: 1,
          taskId: "grandchild-abc234",
          turnId: "turn_0",
        },
        type: "input.requested",
      } as UnstampedMessageStreamEvent,
      sessionId: "remote-1",
    });

    expect(postSessionCallbackRequest).toHaveBeenCalledExactlyOnceWith({
      body: INPUT_BODY,
      logFailures: false,
      url: CALLBACK.url,
    });
    expect(ctx.get(UnsentCallerEventsKey)).toBeUndefined();
  });

  it("posts an authorization event to the caller's callback", async () => {
    const event = createAuthorizationRequiredEvent({
      attemptId: "a-1",
      description: "Sign in to GitHub to continue.",
      name: "github",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_0",
    });

    await forwardEventToRemoteCaller({ ctx: contextWith(CALLBACK), event, sessionId: "remote-1" });

    expect(postSessionCallbackRequest).toHaveBeenCalledExactlyOnceWith({
      body: {
        callId: "call-1",
        event,
        kind: "authorization.event",
        sessionId: "remote-1",
        subagentName: "billing",
        taskProtocol: 1,
      },
      logFailures: false,
      url: CALLBACK.url,
    });
  });

  it("forwards nothing for a session no remote caller started, or for other events", async () => {
    await forwardEventToRemoteCaller({
      ctx: new ContextContainer(),
      event: INPUT_REQUESTED,
      sessionId: "root",
    });
    await forwardEventToRemoteCaller({
      ctx: contextWith(CALLBACK),
      event: { data: { sequence: 3, turnId: "turn_0" }, type: "turn.completed" },
      sessionId: "remote-1",
    });

    expect(postSessionCallbackRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["a network failure", () => Promise.reject(new Error("network down"))],
    [
      "the caller's retry while its session moves",
      () => Promise.resolve(new Response(null, { status: 503 })),
    ],
  ])("keeps an input request to send again after %s", async (_label, respond) => {
    vi.mocked(postSessionCallbackRequest).mockImplementationOnce(respond);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = contextWith(CALLBACK);

    await expect(
      forwardEventToRemoteCaller({ ctx, event: INPUT_REQUESTED, sessionId: "remote-1" }),
    ).resolves.toBeUndefined();

    expect(ctx.get(UnsentCallerEventsKey)).toEqual([{ body: INPUT_BODY, url: CALLBACK.url }]);
    warn.mockRestore();
  });

  it("queues a later event behind one still unsent, so the caller sees them in order", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = contextWith(CALLBACK);
    ctx.set(UnsentCallerEventsKey, [{ body: INPUT_BODY, url: CALLBACK.url }]);

    await forwardEventToRemoteCaller({ ctx, event: INPUT_REQUESTED, sessionId: "remote-1" });

    expect(postSessionCallbackRequest).not.toHaveBeenCalled();
    expect(ctx.get(UnsentCallerEventsKey)).toHaveLength(2);
    warn.mockRestore();
  });

  it("drops an event the caller can never take", async () => {
    vi.mocked(postSessionCallbackRequest).mockResolvedValueOnce(
      Response.json({ code: "TASK_PROTOCOL_MISMATCH", ok: false }, { status: 409 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = contextWith(CALLBACK);

    await forwardEventToRemoteCaller({ ctx, event: INPUT_REQUESTED, sessionId: "remote-1" });

    expect(ctx.get(UnsentCallerEventsKey)).toBeUndefined();
    warn.mockRestore();
  });
});

describe("flushUnsentCallerEventsStep", () => {
  const serializedContext = {
    "eve.sessionId": "remote-1",
    [UnsentCallerEventsKey.name]: [{ body: INPUT_BODY, url: CALLBACK.url }],
  };

  it("sends the owed events in order and clears them", async () => {
    await expect(flushUnsentCallerEventsStep({ serializedContext })).resolves.toEqual({
      "eve.sessionId": "remote-1",
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

function contextWith(callback: typeof CALLBACK): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionCallbackKey, callback);
  return ctx;
}
