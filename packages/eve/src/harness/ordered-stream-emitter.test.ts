import { describe, expect, it, vi } from "vitest";

import { createOrderedStreamEmitter } from "#harness/ordered-stream-emitter.js";
import {
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createReasoningAppendedEvent,
} from "#protocol/message.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function message(delta: string, soFar: string, stepIndex = 0) {
  return createMessageAppendedEvent({
    messageDelta: delta,
    messageSoFar: soFar,
    sequence: 1,
    stepIndex,
    turnId: "turn_1",
  });
}

function reasoning(delta: string, soFar: string) {
  return createReasoningAppendedEvent({
    reasoningDelta: delta,
    reasoningSoFar: soFar,
    sequence: 1,
    stepIndex: 0,
    turnId: "turn_1",
  });
}

describe("createOrderedStreamEmitter", () => {
  it("keeps consuming while a write is active and preserves the latest event metadata", async () => {
    const firstWrite = deferred();
    const events: HandleMessageStreamEvent[] = [];
    const emitFn = vi.fn(async (event: HandleMessageStreamEvent) => {
      events.push(event);
      if (events.length === 1) await firstWrite.promise;
    });
    const emitter = createOrderedStreamEmitter(emitFn);

    await emitter.emit(message("A", "A"));
    await emitter.emit({ ...message("B", "AB"), meta: { at: "2026-07-10T18:00:00.000Z" } });
    await emitter.emit({ ...message("C", "ABC"), meta: { at: "2026-07-10T18:00:01.000Z" } });

    expect(emitFn).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await emitter.closeAndDrain();

    expect(events).toEqual([
      message("A", "A"),
      { ...message("BC", "ABC"), meta: { at: "2026-07-10T18:00:01.000Z" } },
    ]);
  });

  it("treats other event types and stream coordinates as ordering barriers", async () => {
    const firstWrite = deferred();
    const events: HandleMessageStreamEvent[] = [];
    const emitFn = vi.fn(async (event: HandleMessageStreamEvent) => {
      events.push(event);
      if (events.length === 1) await firstWrite.promise;
    });
    const emitter = createOrderedStreamEmitter(emitFn);
    const completed = createMessageCompletedEvent({
      message: "CD",
      sequence: 1,
      stepIndex: 1,
      turnId: "turn_1",
    });

    await emitter.emit(message("A", "A"));
    await emitter.emit(message("B", "AB"));
    await emitter.emit(message("C", "C", 1));
    await emitter.emit(message("D", "CD", 1));
    await emitter.emit(reasoning("R", "R"));
    await emitter.emit(reasoning("S", "RS"));
    await emitter.emit(completed);

    firstWrite.resolve();
    await emitter.closeAndDrain();

    expect(events).toEqual([
      message("A", "A"),
      message("B", "AB"),
      message("CD", "CD", 1),
      reasoning("RS", "RS"),
      completed,
    ]);
  });

  it("surfaces sink failures from close and later emissions", async () => {
    const writeError = new Error("durable write failed");
    const emitter = createOrderedStreamEmitter(async () => {
      throw writeError;
    });

    await emitter.emit(message("A", "A"));

    await expect(emitter.closeAndDrain()).rejects.toBe(writeError);
    await expect(emitter.emit(message("B", "AB"))).rejects.toBe(writeError);
  });

  it("rejects emissions after closing", async () => {
    const emitter = createOrderedStreamEmitter(async () => {});

    await emitter.closeAndDrain();

    await expect(emitter.emit(message("A", "A"))).rejects.toThrow(/closed/);
  });

  it("counts merged empty deltas toward the pending-event limit", async () => {
    const firstWrite = deferred();
    const events: HandleMessageStreamEvent[] = [];
    const emitter = createOrderedStreamEmitter(
      async (event) => {
        events.push(event);
        if (events.length === 1) await firstWrite.promise;
      },
      { maxPendingEvents: 2 },
    );

    await emitter.emit(message("A", "A"));
    await emitter.emit(reasoning("", ""));
    let accepted = false;
    const limited = emitter.emit(reasoning("", "")).then(() => {
      accepted = true;
    });
    await Promise.resolve();

    expect(accepted).toBe(false);
    firstWrite.resolve();
    await limited;
    await emitter.closeAndDrain();
    expect(events).toEqual([message("A", "A"), reasoning("", "")]);
  });
});
