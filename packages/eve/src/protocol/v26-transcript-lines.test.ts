import { describe, expect, it } from "vitest";

import { transcriptOf } from "#client/transcript.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createEventReader } from "#protocol/session-lines.js";
import { readV26TranscriptLine } from "#protocol/v26-transcript-lines.js";

const meta = { at: "2026-10-01T00:00:00.000Z", id: "evt_0" };
const turn = { sequence: 0, turnId: "turn_0" };

/** The transcript of a stream of stored v26 events, one per line. */
function transcriptOfV26(records: readonly unknown[]) {
  const reader = createEventReader();
  const events: SessionStreamEvent[] = [];
  records.forEach((record, position) => {
    const line = readV26TranscriptLine(record, position);
    if (line === undefined) return;
    events.push(...reader.read(line, position));
  });
  return transcriptOf(events).messages;
}

describe("readV26TranscriptLine", () => {
  it("reads what the person sent and the replies, not narration or other events", () => {
    expect(
      transcriptOfV26([
        { data: {}, meta, type: "session.started" },
        {
          data: {
            ...turn,
            message: "Alice shares the venue list.\n[file]",
            parts: [
              { text: "Alice shares the venue list.", type: "text" },
              { filename: "venues.pdf", mediaType: "application/pdf", type: "file" },
            ],
          },
          meta,
          type: "message.received",
        },
        {
          data: { ...turn, finishReason: "tool-calls", message: "Checking.", stepIndex: 0 },
          meta,
          type: "message.completed",
        },
        {
          data: { ...turn, reasoning: "Compare capacity.", stepIndex: 0 },
          type: "reasoning.completed",
        },
        {
          data: { ...turn, finishReason: "stop", message: "The second venue fits.", stepIndex: 1 },
          meta,
          type: "message.completed",
        },
      ]),
    ).toEqual([
      { role: "user", text: "Alice shares the venue list." },
      { role: "assistant", text: "The second venue fits." },
    ]);
  });

  it("starts over at a clear and at a reset that ended a stranded session", () => {
    const received = (message: string) => ({
      data: { ...turn, message },
      meta,
      type: "message.received",
    });
    const failed = (trigger: string) => ({
      data: { code: "session_stranded", details: { trigger }, message: "ended", sessionId: "s" },
      meta,
      type: "session.failed",
    });
    expect(
      transcriptOfV26([
        received("Alice asks about the budget."),
        { data: { ...turn, sessionId: "s" }, meta, type: "context.cleared" },
        received("Bob asks about the schedule."),
      ]),
    ).toEqual([{ role: "user", text: "Bob asks about the schedule." }]);
    expect(transcriptOfV26([received("Bob asks."), failed("reset")])).toEqual([]);
    expect(transcriptOfV26([received("Bob asks."), failed("message")])).toHaveLength(1);
  });

  it("reads nothing from a v27 line or a record it doesn't know", () => {
    expect(readV26TranscriptLine({ at: meta.at, facts: [] }, 0)).toBeUndefined();
    expect(readV26TranscriptLine({ data: {}, type: "action.result" }, 0)).toBeUndefined();
    expect(readV26TranscriptLine("not a record", 0)).toBeUndefined();
  });
});
