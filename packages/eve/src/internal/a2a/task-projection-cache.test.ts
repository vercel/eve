import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PositionedLine } from "#execution/session-event-stream.js";

const streams = new Map<string, unknown[]>();
const reads: { sessionId: string; startIndex: number }[] = [];

vi.mock("#execution/session-event-stream.js", () => ({
  async readSessionStreamTailIndex(sessionId: string) {
    return (streams.get(sessionId) ?? []).length - 1;
  },
  async *streamSessionLines(
    sessionId: string,
    options: { readonly startIndex?: number } = {},
  ): AsyncGenerator<PositionedLine> {
    const startIndex = options.startIndex ?? 0;
    reads.push({ sessionId, startIndex });
    const lines = streams.get(sessionId) ?? [];
    for (let position = startIndex; position < lines.length; position += 1) {
      const line = lines[position] as PositionedLine["line"];
      yield { line, position, record: line };
    }
  },
}));

const { CACHED_SESSION_VIEWS, followSessionView, forgetSessionViews, readSessionView } =
  await import("./task-projection.js");

/** Lines that only advance a view's position. */
function append(sessionId: string, count: number): void {
  const lines = streams.get(sessionId) ?? [];
  for (let i = 0; i < count; i += 1) lines.push({ at: 0, progress: {} });
  streams.set(sessionId, lines);
}

describe("readSessionView", () => {
  beforeEach(() => {
    streams.clear();
    reads.length = 0;
    forgetSessionViews();
  });

  it("folds only the lines since this process last read the session", async () => {
    append("s", 3);
    expect((await readSessionView("s")).position).toBe(3);
    append("s", 2);
    expect((await readSessionView("s")).position).toBe(5);
    expect((await readSessionView("s")).position).toBe(5);
    expect(reads.map((read) => read.startIndex)).toEqual([0, 3, 5]);
  });

  it("folds concurrent reads of one session once each line", async () => {
    append("s", 4);
    const [a, b] = await Promise.all([readSessionView("s"), readSessionView("s")]);
    expect(a).toBe(b);
    expect(a.position).toBe(4);
  });

  it("evicts the least recently read session past its bound", async () => {
    for (let i = 0; i <= CACHED_SESSION_VIEWS; i += 1) {
      append(`s${i}`, 1);
      await readSessionView(`s${i}`);
    }
    reads.length = 0;
    await readSessionView(`s${CACHED_SESSION_VIEWS}`);
    await readSessionView("s0");
    expect(reads).toEqual([
      { sessionId: `s${CACHED_SESSION_VIEWS}`, startIndex: 1 },
      { sessionId: "s0", startIndex: 0 },
    ]);
  });

  it("starts a follow from the kept view without folding into it", async () => {
    append("s", 3);
    const kept = await readSessionView("s");
    append("s", 2);
    const controller = new AbortController();
    const positions: number[] = [];
    for await (const view of followSessionView("s", controller.signal)) {
      expect(view).not.toBe(kept);
      positions.push(view.position);
    }
    expect(reads.at(-1)).toEqual({ sessionId: "s", startIndex: 3 });
    expect(positions).toEqual([5]);
    expect(kept.position).toBe(3);
  });
});
