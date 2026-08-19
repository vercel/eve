import { describe, expect, it } from "vitest";

import {
  createProgressSnapshot,
  MAX_PROGRESS_DEDUPLICATION_IDS,
  MAX_PROGRESS_TEXT_LENGTH,
  normalizeProgressText,
  reduceProgressCommand,
  type ProgressCommandV1,
} from "#execution/session-progress.js";

const turn = {
  id: "turn:root:one",
  phase: "running" as const,
  sequence: 0,
  startedAt: "2026-08-19T12:00:00.000Z",
};

function command(events: ProgressCommandV1["events"], commandId = "command_1") {
  return { commandId, events, kind: "progress" as const, version: 1 as const };
}

describe("reduceProgressCommand", () => {
  it("reduces turn and entity lifecycle", () => {
    const snapshot = reduceProgressCommand(
      createProgressSnapshot(),
      command([
        { eventId: "turn-start", kind: "turn", turn },
        {
          entity: {
            id: "action:root:call_1",
            kind: "tool",
            label: "Search issues",
            phase: "running",
            turnId: turn.id,
          },
          eventId: "tool-start",
          kind: "entity",
        },
      ]),
    );

    expect(snapshot.revision).toBe(1);
    expect(snapshot.turns[turn.id]).toEqual(turn);
    expect(snapshot.entities["action:root:call_1"]).toMatchObject({ phase: "running" });
  });

  it("deduplicates replayed commands and events", () => {
    const first = command([{ eventId: "turn-start", kind: "turn", turn }]);
    const once = reduceProgressCommand(createProgressSnapshot(), first);

    expect(reduceProgressCommand(once, first)).toBe(once);
    expect(reduceProgressCommand(once, command(first.events, "command_2")).revision).toBe(1);
  });

  it("does not reopen terminal lifecycle", () => {
    const settled = reduceProgressCommand(
      createProgressSnapshot(),
      command([
        { eventId: "turn-start", kind: "turn", turn },
        {
          eventId: "turn-end",
          kind: "turn",
          turn: { ...turn, phase: "completed", settledAt: "2026-08-19T12:00:01.000Z" },
        },
      ]),
    );
    const next = reduceProgressCommand(
      settled,
      command([{ eventId: "late", kind: "turn", turn }], "late-command"),
    );

    expect(next.turns[turn.id]?.phase).toBe("completed");
  });

  it("bounds command and event deduplication", () => {
    let snapshot = createProgressSnapshot();
    for (let index = 0; index <= MAX_PROGRESS_DEDUPLICATION_IDS; index += 1) {
      snapshot = reduceProgressCommand(
        snapshot,
        command(
          [
            {
              entity: {
                id: `tool_${String(index)}`,
                kind: "tool",
                label: "Working",
                phase: "running",
                turnId: turn.id,
              },
              eventId: `event_${String(index)}`,
              kind: "entity",
            },
          ],
          `command_${String(index)}`,
        ),
      );
    }

    expect(snapshot.seenCommandIds).toHaveLength(MAX_PROGRESS_DEDUPLICATION_IDS);
    expect(snapshot.seenEventIds).toHaveLength(MAX_PROGRESS_DEDUPLICATION_IDS);
  });

  it("normalizes bounded untrusted text", () => {
    const message = `  one\n\ttwo\u0000 ${"x".repeat(MAX_PROGRESS_TEXT_LENGTH)} `;
    expect(normalizeProgressText(message)).toHaveLength(MAX_PROGRESS_TEXT_LENGTH);
    expect(normalizeProgressText(message)).not.toMatch(/[\u0000-\u001F\u007F]/);
  });
});
