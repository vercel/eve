import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  buildCurrentTimeContext,
  buildSessionDateInstructions,
  dispatchDateTimeInstructionEvent,
} from "#context/date-time-instruction-lifecycle.js";
import { SessionDynamicInstructionsKey } from "#context/keys.js";
import type { MessageStreamEvent } from "#protocol/message.js";

function event(type: "session.started" | "turn.started", at: string): MessageStreamEvent {
  return {
    data: type === "turn.started" ? { sequence: 0, turnId: "turn_0" } : {},
    meta: { at, id: "event_0" },
    type,
  } as MessageStreamEvent;
}

describe("date-time instruction lifecycle", () => {
  it("keeps session instructions stable within a local day and defers to newer context", () => {
    const morning = buildSessionDateInstructions(
      new Date("2026-08-16T08:00:00.000Z"),
      "America/Los_Angeles",
    );
    const evening = buildSessionDateInstructions(
      new Date("2026-08-17T06:59:59.000Z"),
      "America/Los_Angeles",
    );

    expect(morning).toBe(evening);
    expect(morning).toContain("This session started on Sunday, August 16, 2026");
    expect(morning).toContain("prefer the latest request context or message timestamp");
    expect(morning).toContain("Default to calendar periods");
    expect(morning).not.toMatch(/08:00:00|06:59:59|2026-08-16T/u);
    expect(morning).not.toMatch(/Vercel|Slack/u);
  });

  it("formats the current turn time as an unambiguous UTC instant", () => {
    expect(buildCurrentTimeContext(new Date("2026-08-16T20:21:22.123Z"))).toBe(
      "Current time: 2026-08-16T20:21:22.123Z.",
    );
  });

  it("stores the session date without replacing authored session instructions", () => {
    const ctx = new ContextContainer();
    ctx.set(SessionDynamicInstructionsKey, {
      authored: [{ content: "Authored session context.", role: "system" }],
    });

    dispatchDateTimeInstructionEvent({
      ctx,
      event: event("session.started", "2026-08-16T20:21:22.123Z"),
    });

    expect(ctx.require(SessionDynamicInstructionsKey)).toEqual({
      "$eve.date-time": [
        {
          content: expect.stringContaining("Sunday, August 16, 2026"),
          role: "system",
        },
      ],
      authored: [{ content: "Authored session context.", role: "system" }],
    });
  });

  it("does not add user context for framework-only turns", () => {
    const ctx = new ContextContainer();

    dispatchDateTimeInstructionEvent({
      ctx,
      event: event("turn.started", "2026-08-16T20:21:22.123Z"),
    });

    expect([...ctx.entries()]).toEqual([]);
  });
});
