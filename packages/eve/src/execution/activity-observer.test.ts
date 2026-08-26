import { beforeEach, describe, expect, it, vi } from "vitest";

const submitActivityMock = vi.fn();
vi.mock("#execution/submit-activity.js", () => ({
  submitActivity: (...args: unknown[]) => submitActivityMock(...args),
}));

import { createActivityObserver } from "#execution/activity-observer.js";
import type { MessageStreamEvent } from "#protocol/message.js";

const sink = {
  url: "https://agent.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
  version: 1 as const,
};

function event(type: "turn.started" | "turn.completed", turnId = "turn-1"): MessageStreamEvent {
  return {
    data: { sequence: 0, turnId },
    meta: { at: "2026-01-01T00:00:00.000Z", id: `${type}:${turnId}` },
    type,
  };
}

describe("createActivityObserver", () => {
  beforeEach(() => submitActivityMock.mockReset().mockResolvedValue(undefined));

  it("derives root-turn work from canonical events", async () => {
    const observer = createActivityObserver({ sessionId: "session-1", sink });

    await observer.observe(event("turn.started"));
    await observer.observe(event("turn.completed"));

    expect(submitActivityMock.mock.calls.flatMap(([input]) => input.events)).toEqual([
      {
        eventId: "root:session-1:turn-1:started",
        kind: "work.started",
        startedAt: "2026-01-01T00:00:00.000Z",
        work: {
          id: "root:session-1:turn-1",
          kind: "root-turn",
          rootSessionId: "session-1",
          rootTurnId: "turn-1",
          sessionId: "session-1",
          turnId: "turn-1",
        },
      },
      {
        eventId: "root:session-1:turn-1:settled:completed",
        kind: "work.settled",
        outcome: "completed",
        settledAt: "2026-01-01T00:00:00.000Z",
        workId: "root:session-1:turn-1",
      },
    ]);
  });

  it("settles delegated work from the observed terminal event", async () => {
    const observer = createActivityObserver({
      sessionId: "child-session",
      sink,
      workIdentity: {
        callId: "call-1",
        id: "work:parent:turn-1:call-1",
        kind: "subagent",
        name: "researcher",
        parentId: "root:parent:turn-1",
        rootSessionId: "parent",
        rootTurnId: "turn-1",
      },
    });

    await observer.observe(event("turn.completed", "child-turn"));

    expect(submitActivityMock).toHaveBeenCalledWith({
      events: expect.arrayContaining([
        expect.objectContaining({ kind: "work.started" }),
        expect.objectContaining({ kind: "work.settled", outcome: "completed" }),
      ]),
      sink,
    });
  });
});
