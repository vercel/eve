import { describe, expect, it } from "vitest";

import { transcriptOf } from "#client/transcript.js";
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

const stranded = { code: "session_stranded", message: "ended" };

/** What eve writes when a reset ends a stranded session: the admitted control, then the end. */
function strandedReset(): SessionEvent[] {
  return [
    { data: { deliveryId: "reset_0", source: { control: "reset" } }, type: "delivery.admitted" },
    {
      data: { cause: { deliveryId: "reset_0" }, error: stranded, outcome: "failed" },
      type: "session.ended",
    },
  ];
}

function strandedByMessage(): SessionEvent {
  return {
    data: { cause: { policy: "stranded-message" }, error: stranded, outcome: "failed" },
    type: "session.ended",
  };
}

/** Events written together: one line, as a commit is. */
function line(at: number, events: readonly SessionEvent[]) {
  return events.map((event, index) => ({
    ...event,
    meta: {
      at: new Date(Date.UTC(2026, 0, 1) + at).toISOString(),
      endOfLine: index === events.length - 1,
      position: { index, line: at },
    },
  }));
}

function importing(
  history: readonly {
    readonly id?: string;
    readonly role: "user" | "assistant";
    readonly text: string;
  }[],
  message: string,
): SessionEvent {
  const event = received(message);
  return { ...event, data: { ...event.data, history } } as SessionEvent;
}

function reduce(events: readonly SessionEvent[], options?: { readonly maxMessages?: number }) {
  return transcriptOf(
    events.map((event, index) => stampTestEvent(event, index)),
    options,
  );
}

describe("transcriptOf", () => {
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

    expect(reduce([received("Bob asks about the schedule."), ...strandedReset()]).messages).toEqual(
      [],
    );
    expect(
      reduce([received("Bob asks about the schedule."), strandedByMessage()]).messages,
    ).toHaveLength(1);
  });

  it("keeps only the newest maxMessages", () => {
    const events = Array.from({ length: 5 }, (_, index) => received(`Note ${index}`));
    expect(reduce(events, { maxMessages: 2 }).messages).toEqual([
      { role: "user", text: "Note 3" },
      { role: "user", text: "Note 4" },
    ]);
  });

  it.each([0, -1, 1.5])("rejects maxMessages %s", (maxMessages) => {
    expect(() => transcriptOf([], { maxMessages })).toThrow(
      `"maxMessages" must be a positive integer; received ${maxMessages}.`,
    );
  });
  it("reads imported history before what its line's deliveries sent, as the model does", () => {
    const events = [
      ...line(0, [
        importing(
          [
            { id: "app-1", role: "user", text: "Earlier question" },
            { role: "assistant", text: "Earlier answer" },
          ],
          "Deploy it.",
        ),
        importing([{ role: "user", text: "Bob's note" }], "Use staging."),
      ]),
      ...line(1, [content("Done.")]),
      ...line(2, [importing([{ role: "user", text: "Carol's note" }], "Ship it.")]),
    ];
    expect(transcriptOf(events).messages).toEqual([
      { role: "user", text: "Earlier question" },
      { role: "assistant", text: "Earlier answer" },
      { role: "user", text: "Bob's note" },
      { role: "user", text: "Deploy it." },
      { role: "user", text: "Use staging." },
      { role: "assistant", text: "Done." },
      { role: "user", text: "Carol's note" },
      { role: "user", text: "Ship it." },
    ]);
  });
});
