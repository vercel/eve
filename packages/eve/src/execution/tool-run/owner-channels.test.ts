import { describe, expect, it } from "vitest";

import { createChannelReader, raceChannelReads } from "./owner-channels.js";

/** A hook stand-in: an async iterable fed by hand. */
function channel<T>() {
  const queue: T[] = [];
  const waiters: ((value: IteratorResult<T>) => void)[] = [];
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<T>>((resolve) => {
            const value = queue.shift();
            if (value !== undefined) resolve({ done: false, value });
            else waiters.push(resolve);
          }),
      }),
    },
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else queue.push(value);
    },
  };
}

describe("raceChannelReads", () => {
  it("keeps a read that lands between races for the next race to claim", async () => {
    const report = channel<string>();
    const outcome = channel<string>();
    const readers = [
      createChannelReader("report", report.iterable),
      createChannelReader("outcome", outcome.iterable),
    ] as const;

    const first = raceChannelReads(readers);
    outcome.push("done");
    expect(await first).toEqual({ channel: "outcome", next: { done: false, value: "done" } });

    // The report lands while no race is waiting — as when an owner is
    // awaiting a step — and must be delivered by the next race.
    report.push("progress");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await raceChannelReads(readers)).toEqual({
      channel: "report",
      next: { done: false, value: "progress" },
    });
  });

  it("claims landed reads in array order so progress precedes an outcome", async () => {
    const report = channel<string>();
    const outcome = channel<string>();
    const readers = [
      createChannelReader("report", report.iterable),
      createChannelReader("outcome", outcome.iterable),
    ] as const;

    const race = raceChannelReads(readers);
    outcome.push("done");
    report.push("progress");
    expect((await race).channel).toBe("report");
    expect((await raceChannelReads(readers)).channel).toBe("outcome");
  });

  it("returns the extra value when it settles before any channel", async () => {
    const report = channel<string>();
    const readers = [createChannelReader("report", report.iterable)] as const;
    const cancelled = Promise.resolve("cancel" as const);

    expect(await raceChannelReads(readers, cancelled)).toBe("cancel");
    report.push("late");
    expect((await raceChannelReads(readers)).channel).toBe("report");
  });

  it("rethrows a failed read from the race that would have claimed it", async () => {
    const failing = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("hook gone")),
      }),
    };
    const readers = [createChannelReader("report", failing)] as const;
    await expect(raceChannelReads(readers)).rejects.toThrow("hook gone");
  });
});
