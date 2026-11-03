import { describe, expect, it } from "vitest";

import { createEventReader } from "#protocol/session-lines.js";
import {
  createStreamChecker,
  emptySessionView,
  foldEvents,
  turns,
  type StoredLine,
} from "#public/events/index.js";

const at = "2026-10-09T00:00:00.000Z";

function turnLines(turnId: string, follows: string | null, outcome: string): StoredLine[] {
  const scope = { turnId };
  return [
    { at, facts: [{ data: { follows, turnId }, scope, type: "turn.started" }] },
    { at, facts: [{ data: { outcome, turnId }, scope, type: "turn.settled" }] },
  ];
}

describe("eve/events", () => {
  const stream: StoredLine[] = [
    { at, facts: [{ data: {}, type: "session.started" }] },
    ...turnLines("turn_0", null, "completed"),
    ...turnLines("turn_1", "turn_0", "failed"),
  ];

  it("checks a stream and folds the same stream into its turns", () => {
    const checker = createStreamChecker();
    expect(stream.flatMap((line, position) => checker.check(line, position))).toEqual([]);
    const reader = createEventReader();
    const events = stream.flatMap((line, position) => reader.read(line, position));
    expect(
      turns(foldEvents(emptySessionView(), events)).map(({ turnId, status, outcome }) => ({
        outcome,
        status,
        turnId,
      })),
    ).toEqual([
      { outcome: "completed", status: "settled", turnId: "turn_0" },
      { outcome: "failed", status: "settled", turnId: "turn_1" },
    ]);
  });

  it("reports a turn that settles twice", () => {
    const checker = createStreamChecker();
    const twice = [...stream, stream[stream.length - 1]!];
    expect(
      twice.flatMap((line, position) => checker.check(line, position).map((v) => v.rule)),
    ).toEqual(["one-terminal"]);
  });
});
