import { describe, expect, it, vi } from "vitest";

import { MessageResponse } from "#client/message-response.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createSessionWaitingEvent,
  createTurnStartedEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

function createDeferred<T>() {
  return Promise.withResolvers<T>();
}

async function consume(response: MessageResponse): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  for await (const event of response) events.push(event);
  return events;
}

function acceptedCancellation() {
  return { sessionId: "session_1", status: "accepted" as const };
}

describe("MessageResponse cancellation", () => {
  it("queues one guarded cancellation until this response identifies its turn", async () => {
    const start = createDeferred<void>();
    const settle = createDeferred<void>();
    const [turnStarted, boundary] = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    const cancelTurn = vi.fn(async () => acceptedCancellation());
    const response = new MessageResponse({
      cancelTurn,
      createStream: async function* () {
        await start.promise;
        yield turnStarted!;
        await settle.promise;
        yield boundary!;
      },
      sessionId: "session_1",
    });

    const consumed = consume(response);
    const cancellation = response.cancel();
    expect(response.cancel()).toBe(cancellation);
    expect(cancelTurn).not.toHaveBeenCalled();

    start.resolve();
    await expect(cancellation).resolves.toEqual(acceptedCancellation());
    expect(cancelTurn).toHaveBeenCalledOnce();
    expect(cancelTurn).toHaveBeenCalledWith("turn_1");

    settle.resolve();
    await expect(consumed).resolves.toEqual([turnStarted, boundary]);
    await expect(response.cancel()).resolves.toEqual({ status: "no_active_turn" });
  });

  it("allows a failed cancellation request to be retried for the same live turn", async () => {
    const settle = createDeferred<void>();
    const [turnStarted, boundary] = stampTestEvents([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    const cancelTurn = vi
      .fn<(turnId: string) => Promise<ReturnType<typeof acceptedCancellation>>>()
      .mockRejectedValueOnce(new Error("Cancel unavailable"))
      .mockResolvedValueOnce(acceptedCancellation());
    const response = new MessageResponse({
      cancelTurn,
      createStream: async function* () {
        yield turnStarted!;
        await settle.promise;
        yield boundary!;
      },
      sessionId: "session_1",
    });

    const consumed = consume(response);
    await expect(response.cancel()).rejects.toThrow("Cancel unavailable");
    await expect(response.cancel()).resolves.toEqual(acceptedCancellation());
    expect(cancelTurn).toHaveBeenCalledTimes(2);
    expect(cancelTurn).toHaveBeenNthCalledWith(1, "turn_1");
    expect(cancelTurn).toHaveBeenNthCalledWith(2, "turn_1");

    settle.resolve();
    await consumed;
  });

  it("drops a queued cancellation when the response settles without starting a turn", async () => {
    const [boundary] = stampTestEvents([
      createSessionWaitingEvent(),
    ] as UnstampedMessageStreamEvent[]);
    const cancelTurn = vi.fn(async () => acceptedCancellation());
    const response = new MessageResponse({
      cancelTurn,
      createStream: async function* () {
        yield boundary!;
      },
      sessionId: "session_1",
    });

    const consumed = consume(response);
    await expect(response.cancel()).resolves.toEqual({ status: "no_active_turn" });
    await consumed;
    expect(cancelTurn).not.toHaveBeenCalled();
  });
});
