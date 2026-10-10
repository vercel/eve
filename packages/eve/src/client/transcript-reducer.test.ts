import { stampTestEvent } from "#internal/testing/events.js";
import { describe, expect, it } from "vitest";

import { transcriptReducer } from "#client/transcript-reducer.js";
import {
  createContextClearedEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createReasoningCompletedEvent,
  createSessionFailedEvent,
  createSessionStartedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

const TURN = { sequence: 0, turnId: "turn_0" };

function received(message: Parameters<typeof createMessageReceivedEvent>[0]["message"]) {
  return createMessageReceivedEvent({ ...TURN, message });
}

function completed(message: string) {
  return createMessageCompletedEvent({ ...TURN, finishReason: "stop", message, stepIndex: 0 });
}

function reduce(
  events: readonly UnstampedMessageStreamEvent[],
  reducer = transcriptReducer(),
): ReturnType<typeof reducer.initial> {
  return events.reduce(
    (data, event) => reducer.reduce(data, stampTestEvent(event)),
    reducer.initial(),
  );
}

describe("transcriptReducer", () => {
  it("keeps user text and completed assistant text, oldest first", () => {
    expect(
      reduce([
        createSessionStartedEvent(),
        received([
          { text: "Alice shares the venue list.", type: "text" },
          { data: "aGVsbG8=", filename: "venues.pdf", mediaType: "application/pdf", type: "file" },
        ]),
        createReasoningCompletedEvent({ ...TURN, reasoning: "Compare capacity.", stepIndex: 0 }),
        createMessageAppendedEvent({ ...TURN, messageDelta: "The second venue", stepIndex: 0 }),
        completed("The second venue seats everyone."),
        // Output that never completed is partial and never part of the transcript.
        createMessageAppendedEvent({ ...TURN, messageDelta: "Booking it", stepIndex: 1 }),
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
        createContextClearedEvent({ ...TURN, sessionId: "wrun_old" }),
        received("Bob asks about the schedule."),
      ]).messages,
    ).toEqual([{ role: "user", text: "Bob asks about the schedule." }]);

    const ended = (trigger: string) =>
      createSessionFailedEvent({
        code: "session_stranded",
        details: { trigger },
        message: "ended",
        sessionId: "wrun_old",
        usage: undefined,
      });
    expect(reduce([received("Bob asks about the schedule."), ended("reset")]).messages).toEqual([]);
    expect(
      reduce([received("Bob asks about the schedule."), ended("message")]).messages,
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
    expect(reducer.reduce(data, stampTestEvent(createSessionStartedEvent()))).toBe(data);
  });

  it.each([0, -1, 1.5])("rejects maxMessages %s", (maxMessages) => {
    expect(() => transcriptReducer({ maxMessages })).toThrow(
      `"maxMessages" must be a positive integer; received ${maxMessages}.`,
    );
  });
});
