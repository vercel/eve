import { describe, expect, it } from "vitest";

import { transcriptReducer } from "#client/transcript-reducer.js";
import { stampTestEvent } from "#internal/testing/events.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { UserPart } from "#protocol/session-events/envelope.js";

const TURN = "turn_0";
let deliveries = 0;
let parts = 0;

function received(message: string | readonly UserPart[]): SessionEvent {
  deliveries += 1;
  return {
    data: {
      deliveryId: `delivery_${deliveries}`,
      parts: typeof message === "string" ? [{ kind: "text", text: message }] : message,
      turnId: TURN,
    },
    type: "delivery.consumed",
  };
}

function content(
  value: string,
  options: { readonly kind?: string; readonly phase?: string; readonly interrupted?: true } = {},
): SessionEvent {
  parts += 1;
  const data: {
    kind: string;
    partId: string;
    phase: string;
    runId: string;
    value: string;
    interrupted?: true;
  } = {
    kind: options.kind ?? "text",
    partId: `part_${parts}`,
    phase: options.phase ?? "reply",
    runId: "run_0",
    value,
  };
  if (options.interrupted !== undefined) data.interrupted = options.interrupted;
  return { data, scope: { turnId: TURN }, type: "content.completed" };
}

function cleared(): SessionEvent {
  return {
    data: { changeId: "change_0", kind: "clear", outcome: "completed", selects: null },
    type: "context.settled",
  };
}

function strandedEnd(trigger: string): SessionEvent {
  return {
    data: {
      cause: { policy: `stranded-${trigger}` },
      error: { code: "session_stranded", message: "ended" },
      outcome: "failed",
    },
    type: "session.ended",
  };
}

function reduce(
  events: readonly SessionEvent[],
  reducer = transcriptReducer(),
): ReturnType<typeof reducer.initial> {
  return events.reduce(
    (data, event, index) => reducer.reduce(data, stampTestEvent(event, index)),
    reducer.initial(),
  );
}

describe("transcriptReducer", () => {
  it("keeps user text and completed reply text, oldest first", () => {
    expect(
      reduce([
        { data: {}, type: "session.started" },
        received([
          { kind: "text", text: "Alice shares the venue list." },
          { filename: "venues.pdf", kind: "file", mediaType: "application/pdf" },
        ]),
        content("Compare capacity.", { kind: "reasoning" }),
        content("Checking the venues.", { phase: "narration" }),
        content("The second venue seats everyone."),
        // Output a cancel stopped is partial and never part of the transcript.
        content("Booking it", { interrupted: true }),
      ]).messages,
    ).toEqual([
      { role: "user", text: "Alice shares the venue list." },
      { role: "assistant", text: "The second venue seats everyone." },
    ]);
  });

  it("starts over at a clear and at a reset that ended a stranded session", () => {
    expect(
      reduce([
        received("Alice asks about the budget."),
        cleared(),
        received("Bob asks about the schedule."),
      ]).messages,
    ).toEqual([{ role: "user", text: "Bob asks about the schedule." }]);

    expect(
      reduce([received("Bob asks about the schedule."), strandedEnd("reset")]).messages,
    ).toEqual([]);
    expect(
      reduce([received("Bob asks about the schedule."), strandedEnd("message")]).messages,
    ).toHaveLength(1);
  });

  it("keeps only the newest maxMessages", () => {
    const events = Array.from({ length: 5 }, (_, index) => received(`Note ${index}`));
    expect(reduce(events, transcriptReducer({ maxMessages: 2 })).messages).toEqual([
      { role: "user", text: "Note 3" },
      { role: "user", text: "Note 4" },
    ]);
  });

  it("returns its input unchanged for events it ignores", () => {
    const reducer = transcriptReducer();
    const data = reducer.initial();
    expect(reducer.reduce(data, stampTestEvent({ data: {}, type: "session.started" }))).toBe(data);
  });

  it.each([0, -1, 1.5])("rejects maxMessages %s", (maxMessages) => {
    expect(() => transcriptReducer({ maxMessages })).toThrow(
      `"maxMessages" must be a positive integer; received ${maxMessages}.`,
    );
  });
});
