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
  it("keeps consuming while a write is active and merges adjacent pending text", async () => {
    const firstWrite = deferred();
    const events: HandleMessageStreamEvent[] = [];
    const emitFn = vi.fn(async (event: HandleMessageStreamEvent) => {
      events.push(event);
      if (events.length === 1) await firstWrite.promise;
    });
    const emitter = createOrderedStreamEmitter(emitFn);

    await emitter.emit(message("A", "A"));
    await emitter.emit(message("B", "AB"));
    await emitter.emit(message("C", "ABC"));

    expect(emitFn).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await emitter.drain();

    expect(events).toEqual([message("A", "A"), message("BC", "ABC")]);
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
    await emitter.drain();

    expect(events).toEqual([
      message("A", "A"),
      message("B", "AB"),
      message("CD", "CD", 1),
      reasoning("RS", "RS"),
      completed,
    ]);
  });

  it("surfaces sink failures from drain and later emissions", async () => {
    const writeError = new Error("durable write failed");
    const emitter = createOrderedStreamEmitter(async () => {
      throw writeError;
    });

    await emitter.emit(message("A", "A"));

    await expect(emitter.drain()).rejects.toBe(writeError);
    await expect(emitter.emit(message("B", "AB"))).rejects.toBe(writeError);
  });
});
