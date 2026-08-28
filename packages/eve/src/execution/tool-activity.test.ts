import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ActivityObserverKey, SessionKey } from "#context/keys.js";
import { createToolActivity } from "#execution/tool-activity.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";

const session = {
  auth: { current: null, initiator: null },
  sessionId: "session-1",
  turn: { id: "turn-1", sequence: 1 },
};

describe("createToolActivity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("publishes bounded action updates without session delivery", async () => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 202 });
      }),
    );
    const ctx = new ContextContainer();
    ctx.set(SessionKey, session);
    ctx.set(ActivityObserverKey, {
      sink: {
        url: "https://parent.example/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
        version: 1,
      },
    });

    await contextStorage.run(ctx, async () => {
      const activity = createToolActivity({
        callId: "call-1",
        sessionId: session.sessionId,
        turnId: session.turn.id,
      });
      await activity.update("Comparing\u0007   the renderer");
      await activity.update("Validating the projection");
    });

    const workId = deriveRootTurnActivityWorkId({ sessionId: "session-1", turnId: "turn-1" });
    expect(requests).toEqual([
      {
        events: [
          expect.objectContaining({
            actionId: `action:${workId}:call-1`,
            eventId: expect.stringMatching(`^action:${workId}:call-1:updated:`),
            kind: "action.updated",
            message: "Comparing the renderer",
          }),
        ],
        version: 1,
      },
      {
        events: [
          expect.objectContaining({
            actionId: `action:${workId}:call-1`,
            eventId: expect.stringMatching(`^action:${workId}:call-1:updated:`),
            kind: "action.updated",
            message: "Validating the projection",
          }),
        ],
        version: 1,
      },
    ]);
  });

  it("is a no-op when the session has no activity collector", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, session);

    await contextStorage.run(ctx, async () => {
      await createToolActivity({
        callId: "call-1",
        sessionId: session.sessionId,
        turnId: session.turn.id,
      }).update("Working");
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
