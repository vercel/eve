import { describe, expect, it, vi } from "vitest";
import { SteeringStream } from "#cli/dev/tui/steering-stream.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createMessageAppendedEvent,
  createMessageReceivedEvent,
  createSessionWaitingEvent,
  createTurnCancelledEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";

describe("SteeringStream", () => {
  it("deduplicates a steering response on the same turn and emits its boundary once", async () => {
    const events = stampTestEvents([
      createMessageReceivedEvent({ message: "first", sequence: 0, turnId: "turn_0" }),
      createMessageReceivedEvent({ message: "steer", sequence: 0, turnId: "turn_0" }),
      createSessionWaitingEvent(),
    ]);
    const session = {
      cancel: vi.fn(async () => ({ status: "cancelled" })),
      send: vi.fn(async () => iterate(events.slice(1))),
    };
    const stream = new SteeringStream(iterate(events), session);
    await stream.send("steer");
    expect(await collect(stream)).toEqual(events);
    expect(session.cancel).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      turnId: undefined,
    });
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
      cancel: async () => ({ status: "cancelled" }),
      send: async () => iterate(events.slice(2)),
    });
    await stream.send("later");
    expect(await collect(stream)).toEqual([events[0], events[2], events[3]]);
  });

  it("skips an overlapping settled boundary before following the accepted turn", async () => {
    const events = stampTestEvents([
      createMessageReceivedEvent({ message: "first", sequence: 0, turnId: "turn_0" }),
      createSessionWaitingEvent(),
      createMessageReceivedEvent({ message: "later", sequence: 1, turnId: "turn_1" }),
      createSessionWaitingEvent(),
    ]);
    const stream = new SteeringStream(iterate(events.slice(0, 2)), {
      cancel: async () => ({ status: "cancelled" }),
      send: async () => iterate(events.slice(1)),
    });
    await stream.send("later");
    expect(await collect(stream)).toEqual([events[0], events[2], events[3]]);
  });

  it("aborts all accepted follow-up responses when the consumer detaches", async () => {
    const signals: AbortSignal[] = [];
    const stream = new SteeringStream(iterate([]), {
      cancel: async () => ({ status: "cancelled" }),
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
      cancel: async () => ({ status: "cancelled" }),
      send: async () => {
        throw new Error("send failed");
      },
    });
    await expect(stream.send("steer")).rejects.toThrow("send failed");
    expect(await collect(stream)).toEqual(events);
    await expect(stream.send("late")).rejects.toThrow("active stream ended");
  });

  it("cancels and restarts when steering arrives before assistant output", async () => {
    const events = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
      createMessageReceivedEvent({ message: "first", sequence: 0, turnId: "turn_0" }),
      createTurnCancelledEvent({ sequence: 0, turnId: "turn_0" }),
      createSessionWaitingEvent(),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      createMessageReceivedEvent({ message: "steer", sequence: 1, turnId: "turn_1" }),
      createSessionWaitingEvent(),
    ]);
    const initial = events.slice(0, 4);
    const steered = events.slice(4);
    const calls: string[] = [];
    const turnObserved = Promise.withResolvers<void>();
    const resumeInitial = Promise.withResolvers<void>();
    const initialStream = async function* () {
      yield initial[0]!;
      yield initial[1]!;
      turnObserved.resolve();
      await resumeInitial.promise;
      yield initial[2]!;
      yield initial[3]!;
    };
    const session = {
      cancel: vi.fn(async () => {
        calls.push("cancel");
        return { status: "cancelled" };
      }),
      send: vi.fn(async () => {
        calls.push("send");
        return iterate(steered);
      }),
    };
    const stream = new SteeringStream(initialStream(), session);
    const collecting = collect(stream);
    await turnObserved.promise;
    await stream.send("steer");
    expect(stream.isRestartCancellation("turn_0")).toBe(true);
    resumeInitial.resolve();

    expect(await collecting).toEqual([
      initial[0],
      initial[1],
      initial[2],
      steered[0],
      steered[1],
      steered[2],
    ]);
    expect(calls).toEqual(["cancel", "send"]);
    expect(session.cancel).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      turnId: "turn_0",
    });
  });

  it("keeps boundary steering after assistant output starts", async () => {
    const events = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
      createMessageAppendedEvent({
        messageDelta: "The answer",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
      createSessionWaitingEvent(),
    ]);
    const cancel = vi.fn(async () => ({ status: "cancelled" }));
    const session = {
      cancel,
      send: vi.fn(async () => iterate([])),
    };
    const stream = new SteeringStream(iterate(events), session);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: events[0] });
    await expect(iterator.next()).resolves.toMatchObject({ value: events[1] });
    await stream.send("steer");
    await iterator.return(undefined);

    expect(cancel).not.toHaveBeenCalled();
    expect(session.send).toHaveBeenCalledOnce();
    expect(stream.isRestartCancellation("turn_0")).toBe(false);
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
