import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SessionCallbackKey } from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import {
  createAuthorizationRequiredEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { forwardEventToRemoteCaller } from "#subagents/remote-caller-events.js";

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

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(postSessionCallbackRequest).mockResolvedValue(new Response(null, { status: 202 }));
});

describe("forwardEventToRemoteCaller", () => {
  it("posts an input request to the caller's callback, without a descendant's task id", async () => {
    await forwardEventToRemoteCaller({
      ctx: contextWith(CALLBACK),
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
      body: {
        callId: "call-1",
        event: { requests: REQUESTS, sequence: 3, stepIndex: 1, turnId: "turn_0" },
        kind: "input.requested",
        sessionId: "remote-1",
        subagentName: "billing",
      },
      url: CALLBACK.url,
    });
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
      },
      url: CALLBACK.url,
    });
  });

  it("forwards nothing for a session no remote caller started, or for other events", async () => {
    const request = {
      data: { requests: REQUESTS, sequence: 3, stepIndex: 1, turnId: "turn_0" },
      type: "input.requested",
    } as UnstampedMessageStreamEvent;
    await forwardEventToRemoteCaller({
      ctx: new ContextContainer(),
      event: request,
      sessionId: "root",
    });
    await forwardEventToRemoteCaller({
      ctx: contextWith(CALLBACK),
      event: { data: { sequence: 3, turnId: "turn_0" }, type: "turn.completed" },
      sessionId: "remote-1",
    });

    expect(postSessionCallbackRequest).not.toHaveBeenCalled();
  });

  it("logs a failed forward instead of failing the child's step", async () => {
    vi.mocked(postSessionCallbackRequest).mockRejectedValueOnce(new Error("network down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      forwardEventToRemoteCaller({
        ctx: contextWith(CALLBACK),
        event: {
          data: { requests: REQUESTS, sequence: 3, stepIndex: 1, turnId: "turn_0" },
          type: "input.requested",
        } as UnstampedMessageStreamEvent,
        sessionId: "remote-1",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

function contextWith(callback: typeof CALLBACK): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionCallbackKey, callback);
  return ctx;
}
