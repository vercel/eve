import { describe, expect, it } from "vitest";

import {
  createProgressSnapshot,
  MAX_PROGRESS_DEDUPLICATION_IDS,
  MAX_PROGRESS_ENTITIES,
  MAX_PROGRESS_EVENTS_PER_COMMAND,
  MAX_PROGRESS_TEXT_LENGTH,
  normalizeProgressText,
  parseProgressCommandV1,
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
    expect(snapshot.entities["action:root:call_1"]).toMatchObject({
      label: "Search issues",
      phase: "running",
    });
  });

  it("deduplicates replayed commands and events", () => {
    const first = command([{ eventId: "turn-start", kind: "turn", turn }]);
    const once = reduceProgressCommand(createProgressSnapshot(), first);

    expect(reduceProgressCommand(once, first)).toBe(once);
    expect(reduceProgressCommand(once, command(first.events, "command_2")).revision).toBe(1);
  });

  it("replaces one report per turn and clears it at terminal settlement", () => {
    const initial = reduceProgressCommand(
      createProgressSnapshot(),
      command([
        {
          eventId: "report-one",
          kind: "report",
          report: { id: "one", message: "Searching", reportedAt: turn.startedAt },
          turn,
        },
        {
          eventId: "report-two",
          kind: "report",
          report: { id: "two", message: "Testing", reportedAt: turn.startedAt },
          turn,
        },
      ]),
    );
    expect(initial.turns[turn.id]?.report?.message).toBe("Testing");

    const settled = reduceProgressCommand(
      initial,
      command(
        [
          {
            eventId: "settled",
            kind: "turn",
            turn: { ...turn, phase: "completed", settledAt: turn.startedAt },
          },
        ],
        "settled",
      ),
    );
    expect(settled.turns[turn.id]?.report).toBeUndefined();
    const late = reduceProgressCommand(
      settled,
      command(
        [
          {
            eventId: "late-report",
            kind: "report",
            report: { id: "late", message: "Too late", reportedAt: turn.startedAt },
            turn,
          },
        ],
        "late",
      ),
    );
    expect(late.turns[turn.id]?.report).toBeUndefined();
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

  it("advances revision after event deduplication reaches capacity", () => {
    let snapshot = createProgressSnapshot();
    for (let index = 0; index < MAX_PROGRESS_DEDUPLICATION_IDS; index += 1) {
      snapshot = reduceProgressCommand(
        snapshot,
        command(
          [
            {
              entity: {
                id: "tool",
                kind: "tool",
                label: `Update ${String(index)}`,
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
    const revision = snapshot.revision;
    const next = reduceProgressCommand(
      snapshot,
      command(
        [
          {
            entity: {
              id: "tool",
              kind: "tool",
              label: "After saturation",
              phase: "running",
              turnId: turn.id,
            },
            eventId: "event_after_saturation",
            kind: "entity",
          },
        ],
        "command_after_saturation",
      ),
    );

    expect(next.revision).toBe(revision + 1);
    expect(next.entities["tool"]?.label).toBe("After saturation");
    expect(next.seenEventIds).toHaveLength(MAX_PROGRESS_DEDUPLICATION_IDS);
  });

  it("validates the complete progress wire vocabulary", () => {
    expect(
      parseProgressCommandV1(command([{ eventId: "turn", kind: "turn", turn }])),
    ).toBeDefined();
    expect(
      parseProgressCommandV1(
        command([
          {
            entity: {
              id: "tool",
              kind: "future-invalid-kind" as "tool",
              label: "Working",
              phase: "unknown" as "running",
              turnId: turn.id,
            },
            eventId: "invalid",
            kind: "entity",
          },
        ]),
      ),
    ).toBeUndefined();
  });

  it("accepts bounded root-turn grouping on the wire", () => {
    expect(
      parseProgressCommandV1(
        command([
          {
            eventId: "grouped-turn",
            kind: "turn",
            turn: { ...turn, groupId: "turn:root:root-turn" },
          },
        ]),
      ),
    ).toBeDefined();
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

  it("bounds entities and events accepted from one command", () => {
    const events = Array.from(
      { length: MAX_PROGRESS_ENTITIES + MAX_PROGRESS_EVENTS_PER_COMMAND },
      (_, index) => ({
        entity: {
          id: `tool_${String(index)}`,
          kind: "tool" as const,
          label: "Working",
          phase: "running" as const,
          turnId: turn.id,
        },
        eventId: `event_${String(index)}`,
        kind: "entity" as const,
      }),
    );
    let snapshot = createProgressSnapshot();
    for (let offset = 0; offset < events.length; offset += MAX_PROGRESS_EVENTS_PER_COMMAND) {
      snapshot = reduceProgressCommand(
        snapshot,
        command(events.slice(offset, offset + MAX_PROGRESS_EVENTS_PER_COMMAND), `batch_${offset}`),
      );
    }
    expect(Object.keys(snapshot.entities)).toHaveLength(MAX_PROGRESS_ENTITIES);

    const oneCommand = reduceProgressCommand(
      createProgressSnapshot(),
      command(events, "oversized"),
    );
    expect(Object.keys(oneCommand.entities)).toHaveLength(MAX_PROGRESS_EVENTS_PER_COMMAND);
  });

  it("normalizes bounded untrusted text at the reducer boundary", () => {
    const message = `  one\n\ttwo\u0000 ${"x".repeat(MAX_PROGRESS_TEXT_LENGTH)} `;
    expect(normalizeProgressText(message)).toHaveLength(MAX_PROGRESS_TEXT_LENGTH);
    expect(normalizeProgressText(message)).not.toMatch(/[\u0000-\u001F\u007F]/);
    const snapshot = reduceProgressCommand(
      createProgressSnapshot(),
      command([
        {
          entity: {
            id: "tool",
            kind: "tool",
            label: message,
            phase: "running",
            turnId: turn.id,
          },
          eventId: "untrusted",
          kind: "entity",
        },
      ]),
    );
    expect(snapshot.entities["tool"]?.label).toBe(normalizeProgressText(message));
  });
});
