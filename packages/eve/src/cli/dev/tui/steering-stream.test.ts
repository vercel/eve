import { describe, expect, it, vi } from "vitest";
import { SteeringStream } from "#cli/dev/tui/steering-stream.js";
import { stampTestEvents } from "#internal/testing/events.js";
import { createMessageReceivedEvent, createSessionWaitingEvent } from "#protocol/message.js";

describe("SteeringStream", () => {
  it("deduplicates a steering response on the same turn and emits its boundary once", async () => {
    const events = stampTestEvents([
      createMessageReceivedEvent({ message: "first", sequence: 0, turnId: "turn_0" }),
      createMessageReceivedEvent({ message: "steer", sequence: 0, turnId: "turn_0" }),
      createSessionWaitingEvent(),
    ]);
    const session = { send: vi.fn(async () => iterate(events.slice(1))) };
    const stream = new SteeringStream(iterate(events), session);
    await stream.send("steer");
    expect(await collect(stream)).toEqual(events);
    expect(session.send).toHaveBeenCalledWith("steer", {
      turnPolicy: "steer",
      signal: expect.any(AbortSignal),
    });
  });

  it("follows a message accepted after the original turn settled", async () => {
    const events = stampTestEvents([
      createMessageReceivedEvent({ message: "first", sequence: 0, turnId: "turn_0" }),
      createSessionWaitingEvent(),
      createMessageReceivedEvent({ message: "later", sequence: 1, turnId: "turn_1" }),
      createSessionWaitingEvent(),
    ]);
    const stream = new SteeringStream(iterate(events.slice(0, 2)), {
      send: async () => iterate(events.slice(2)),
    });
    await stream.send("later");
    expect(await collect(stream)).toEqual([events[0], events[2], events[3]]);
  });

  it("aborts all accepted follow-up responses when the consumer detaches", async () => {
    const signals: AbortSignal[] = [];
    const stream = new SteeringStream(iterate([]), {
      send: async (_message, options) => {
        signals.push(options.signal);
        return iterate([]);
      },
    });
    await stream.send("first");
    await stream.send("second");
    stream.abort();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await expect(stream.send("late")).rejects.toThrow("active stream ended");
  });

  it("reports failed admission without losing the original stream boundary", async () => {
    const events = stampTestEvents([createSessionWaitingEvent()]);
    const stream = new SteeringStream(iterate(events), {
      send: async () => {
        throw new Error("send failed");
      },
    });
    await expect(stream.send("steer")).rejects.toThrow("send failed");
    expect(await collect(stream)).toEqual(events);
    await expect(stream.send("late")).rejects.toThrow("active stream ended");
  });
});

async function* iterate<T>(values: readonly T[]): AsyncGenerator<T> {
  yield* values;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
