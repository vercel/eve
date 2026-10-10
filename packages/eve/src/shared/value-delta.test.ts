import { describe, expect, it } from "vitest";

import { applyValueDelta, diffValue, snapshotValue } from "#shared/value-delta.js";

describe("value deltas", () => {
  it("rebuild the next value exactly after crossing a serialization boundary", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = seededRandom(seed);
      const base = randomValue(random, 4);
      const next = edit(base, random, 4);

      // The workflow body applies a deserialized delta to its deserialized copy of the base.
      const rebuilt = applyValueDelta(
        structuredClone(base),
        structuredClone(diffValue(base, next)),
      );

      expect(rebuilt, `seed ${seed}`).toStrictEqual(next);
      expect(layout(rebuilt), `seed ${seed}`).toBe(layout(next));
    }
  });

  it("carry only what changed and share every unchanged entry with the base", () => {
    const history = Array.from({ length: 50 }, (_, index) => ({
      content: `Alice's message ${index}`,
      role: "user",
    }));
    const base = {
      sequence: 4,
      session: { history, system: "You help Alice and Bob plan their projects." },
    };
    const next = {
      ...base,
      sequence: 5,
      session: {
        ...base.session,
        history: [...history, { content: "Bob's reply", role: "assistant" }],
      },
    };

    const delta = diffValue(base, next);
    const rebuilt = applyValueDelta(base, delta);

    expect(JSON.stringify(delta)).toContain("Bob's reply");
    expect(JSON.stringify(delta)).not.toMatch(/Alice's message|You help Alice/);
    expect(rebuilt).toStrictEqual(next);
    expect(rebuilt.session.history[0]).toBe(history[0]);
    expect(diffValue(base, snapshotValue(base))).toBeUndefined();
  });
});

type Random = () => number;

const KEYS = ["alice", "bob", "status", "history", "turnId", "1", "10"];

function seededRandom(seed: number): Random {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: Random, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function randomValue(random: Random, depth: number): unknown {
  const kind = depth === 0 ? pick(random, LEAVES) : pick(random, [...LEAVES, "array", "object"]);
  switch (kind) {
    case "array":
      return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth - 1));
    case "object":
      return Object.fromEntries(
        KEYS.filter(() => random() < 0.4).map((key) => [key, randomValue(random, depth - 1)]),
      );
    case "string":
      return pick(random, ["", "draft", "ready for Bob"]);
    case "number":
      return pick(random, [0, -0, 1, 2.5, Number.NaN]);
    case "date":
      return new Date(Math.floor(random() * 4) * 86_400_000);
    case "bytes":
      return new Uint8Array([Math.floor(random() * 3)]);
    default:
      return pick(random, [true, false, null, undefined]);
  }
}

const LEAVES = ["string", "number", "date", "bytes", "literal"] as const;

/** A copy of `value` with random edits, sharing what it leaves alone, as a step's result does. */
function edit(value: unknown, random: Random, depth: number): unknown {
  if (random() < 0.3) return value;
  if (Array.isArray(value)) {
    const next = value.map((entry) => edit(entry, random, depth - 1));
    if (random() < 0.3) next.push(randomValue(random, depth - 1));
    if (random() < 0.2) next.pop();
    if (random() < 0.2) next.unshift(randomValue(random, depth - 1));
    return next;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    !ArrayBuffer.isView(value)
  ) {
    const entries = Object.entries(value).flatMap(([key, entry]): [string, unknown][] =>
      random() < 0.15 ? [] : [[key, edit(entry, random, depth - 1)]],
    );
    if (random() < 0.3) entries.push([pick(random, KEYS), randomValue(random, depth - 1)]);
    if (random() < 0.2) entries.reverse();
    return Object.fromEntries(entries);
  }
  return random() < 0.5 ? randomValue(random, depth) : value;
}

/** Key order and `undefined` entries, which structural equality ignores. */
function layout(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry === undefined ? "<undefined>" : entry,
  );
}
