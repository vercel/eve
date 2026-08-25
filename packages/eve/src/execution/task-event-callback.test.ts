import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ContinuationTokenKey, SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { fireTaskEventCallbackStep } from "#execution/session-callback-step.js";
import { forwardTaskEventToSessionCallback } from "#execution/task-event-callback.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

vi.mock("#execution/session-callback-step.js", () => ({
  fireTaskEventCallbackStep: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

describe("forwardTaskEventToSessionCallback", () => {
  it.each<
    Extract<UnstampedMessageStreamEvent, { type: "approval.candidate" | "approval.settled" }>
  >([
    {
      data: {
        candidateId: "candidate-1",
        outcome: "pending",
        requestId: "approval-1",
        responderPrincipalId: "user-1",
        sequence: 1,
        stepIndex: 2,
        turnId: "turn-child",
      },
      type: "approval.candidate",
    },
    {
      data: {
        outcome: "approved",
        requestId: "approval-1",
        responderPrincipalId: "user-1",
        sequence: 1,
        stepIndex: 3,
        turnId: "turn-child",
      },
      type: "approval.settled",
    },
  ])("forwards $type for a remote task child", async (event) => {
    const ctx = new ContextContainer();
    const callback = {
      callId: "call-task",
      subagentName: "research",
      taskId: "task-1",
      token: "task-token",
      url: "https://remote.example.com/eve/v1/callback/task-token",
    };
    ctx.set(ContinuationTokenKey, "child-token");
    ctx.set(SessionCallbackKey, callback);
    ctx.set(SessionIdKey, "child-session");

    await expect(forwardTaskEventToSessionCallback(ctx, event)).resolves.toBe(true);
    expect(fireTaskEventCallbackStep).toHaveBeenCalledExactlyOnceWith({
      callback,
      childContinuationToken: "child-token",
      childSessionId: "child-session",
      event,
    });
  });
});
