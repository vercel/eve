import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { HandleEventKey, SessionKey } from "#context/keys.js";
import { createToolActivity } from "#execution/tool-activity.js";

const session = {
  auth: { current: null, initiator: null },
  sessionId: "session-1",
  turn: { id: "turn-1", sequence: 1 },
};

describe("createToolActivity", () => {
  it("emits normalized action updates through the canonical session event handler", async () => {
    const events: unknown[] = [];
    const ctx = new ContextContainer();
    ctx.set(SessionKey, session);
    ctx.setVirtualContext(HandleEventKey, async (event) => {
      events.push(event);
    });

    await contextStorage.run(ctx, async () => {
      const activity = createToolActivity({ callId: "call-1" });
      await activity.update("Comparing\u0007   the renderer");
      await activity.update("Validating the projection");
    });

    expect(events).toEqual([
      {
        data: {
          callId: "call-1",
          message: "Comparing the renderer",
          sequence: 1,
          turnId: "turn-1",
        },
        type: "action.updated",
      },
      {
        data: {
          callId: "call-1",
          message: "Validating the projection",
          sequence: 1,
          turnId: "turn-1",
        },
        type: "action.updated",
      },
    ]);
  });

  it("does not let event-emission failure alter the tool result", async () => {
    const ctx = new ContextContainer();
    ctx.set(SessionKey, session);
    ctx.setVirtualContext(
      HandleEventKey,
      vi.fn(async () => Promise.reject(new Error("unavailable"))),
    );

    await expect(
      contextStorage.run(ctx, async () => {
        await createToolActivity({ callId: "call-1" }).update("Working");
      }),
    ).resolves.toBeUndefined();
  });
});
