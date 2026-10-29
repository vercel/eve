import { describe, expect, it } from "vitest";
import { diffValue } from "#shared/value-delta.js";
import {
  readHistoryBoundaries,
  retainHistoryBoundaries,
  writeHistoryBoundaries,
  type HistoryBoundary,
} from "./history-boundaries.js";

const boundaries: readonly HistoryBoundary[] = [
  { turnId: "one", length: 1, follows: null },
  { turnId: "two", length: 2, follows: "one" },
  { turnId: "three", length: 3, follows: "two" },
];
const history = [{ text: "one" }, { text: "two" }, { text: "three" }];

function retained(next: unknown) {
  return retainHistoryBoundaries(boundaries, history.length, diffValue(history, next));
}

describe("history boundary storage", () => {
  it("round trips boundaries without disturbing other state", () => {
    const state = writeHistoryBoundaries({ other: 1 }, boundaries);
    expect(state.other).toBe(1);
    expect(readHistoryBoundaries(state)).toEqual(boundaries);
  });

  it("ignores malformed records", () => {
    const state = {
      "eve.execution.historyBoundaries": [
        boundaries[0],
        null,
        { turnId: "bad", length: -1, follows: null },
      ],
    };
    expect(readHistoryBoundaries(state)).toEqual([boundaries[0]]);
  });
});

describe("retainHistoryBoundaries", () => {
  it("retains boundaries when history is unchanged or appended", () => {
    expect(retained(history)).toEqual(boundaries);
    expect(retained([...history, { text: "four" }])).toEqual(boundaries);
  });

  it("invalidates each boundary whose prefix contains a patched entry", () => {
    expect(retained([history[0], { text: "repaired" }, history[2]])).toEqual([boundaries[0]]);
    expect(retained([{ text: "repaired" }, history[1], history[2]])).toEqual([]);
  });

  it("invalidates boundaries past a truncation", () => {
    expect(retained(history.slice(0, 2))).toEqual(boundaries.slice(0, 2));
  });

  it("rejects a whole replacement even when the last entry is unchanged", () => {
    expect(
      retainHistoryBoundaries(boundaries, history.length, {
        kind: "value",
        value: [{ text: "different" }, history[1], history[2]],
      }),
    ).toEqual([]);
  });

  it("rejects malformed or impossible boundary lengths", () => {
    expect(
      retainHistoryBoundaries(
        [
          { turnId: "negative", length: -1, follows: null },
          { turnId: "fraction", length: 1.5, follows: null },
          { turnId: "too-long", length: 4, follows: null },
          boundaries[0]!,
        ],
        history.length,
        undefined,
      ),
    ).toEqual([boundaries[0]]);
  });

  it("rejects malformed delta indices rather than assuming the prefix is safe", () => {
    expect(
      retainHistoryBoundaries(boundaries, history.length, {
        kind: "array",
        length: 4,
        set: { nope: { text: "four" } },
      }),
    ).toEqual([]);
  });
});
