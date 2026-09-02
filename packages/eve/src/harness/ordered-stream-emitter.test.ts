import { describe, expect, it, vi } from "vitest";

import { createOrderedStreamEmitter } from "#harness/ordered-stream-emitter.js";
import {
  createActionInputAppendedEvent,
  createActionPartialEvent,
  createActionResultEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createReasoningAppendedEvent,
} from "#protocol/message.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function message(delta: string, offset: number, stepIndex = 0) {
  return createMessageAppendedEvent({
    messageDelta: delta,
    messageOffset: offset,
    sequence: 1,
    stepIndex,
    turnId: "turn_1",
  });
}

function reasoning(delta: string, offset: number) {
  return createReasoningAppendedEvent({
    reasoningDelta: delta,
    reasoningOffset: offset,
    sequence: 1,
    stepIndex: 0,
    turnId: "turn_1",
  });
}

function partial(callId: string, output: string) {
  return createActionPartialEvent({
    result: { callId, kind: "tool-result", output, toolName: "progress" },
    sequence: 1,
    stepIndex: 0,
    turnId: "turn_1",
  });
}

function input(callId: string, delta: string, offset: number) {
  return createActionInputAppendedEvent({
    callId,
    inputTextDelta: delta,
    inputTextOffset: offset,
    sequence: 1,
    stepIndex: 0,
    toolName: "render",
    turnId: "turn_1",
  });
}

describe("createOrderedStreamEmitter", () => {
  it("keeps consuming while a write is active and preserves the latest event payload", async () => {
    const firstWrite = deferred();
    const events: UnstampedMessageStreamEvent[] = [];
    const emitFn = vi.fn(async (event: UnstampedMessageStreamEvent) => {
      events.push(event);
      if (events.length === 1) await firstWrite.promise;
    });
    const emitter = createOrderedStreamEmitter(emitFn);

    await emitter.emit(message("A", 0));
    await emitter.emit(message("B", 1));
    await emitter.emit(message("C", 2));

    expect(emitFn).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await emitter.closeAndDrain();

    expect(events).toEqual([message("A", 0), message("BC", 1)]);
  });

  it("coalesces adjacent input deltas for the same tool call", async () => {
    const firstWrite = deferred();
    const events: UnstampedMessageStreamEvent[] = [];
    const emitFn = vi.fn(async (event: UnstampedMessageStreamEvent) => {
      events.push(event);
      if (events.length === 1) await firstWrite.promise;
    });
    const emitter = createOrderedStreamEmitter(emitFn);

    await emitter.emit(message("A", 0));
    await emitter.emit(input("call_1", "{", 0));
    await emitter.emit(input("call_1", '"title":', 1));
    await emitter.emit(input("call_1", '"Hello"}', 9));
    await emitter.emit(input("call_2", "{}", 0));

    firstWrite.resolve();
    await emitter.closeAndDrain();

    expect(events).toEqual([
      message("A", 0),
      input("call_1", '{"title":"Hello"}', 0),
      input("call_2", "{}", 0),
    ]);
  });

  it("treats other event types and stream coordinates as ordering barriers", async () => {
    const firstWrite = deferred();
    const events: UnstampedMessageStreamEvent[] = [];
    const emitFn = vi.fn(async (event: UnstampedMessageStreamEvent) => {
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

    await emitter.emit(message("A", 0));
    await emitter.emit(message("B", 1));
    await emitter.emit(message("C", 0, 1));
    await emitter.emit(message("D", 1, 1));
    await emitter.emit(reasoning("R", 0));
    await emitter.emit(reasoning("S", 1));
    await emitter.emit(completed);

    firstWrite.resolve();
    await emitter.closeAndDrain();

    expect(events).toEqual([
      message("A", 0),
      message("B", 1),
      message("CD", 0, 1),
      reasoning("RS", 0),
      completed,
    ]);
  });

  it("keeps the newest adjacent partial for each call and preserves terminal barriers", async () => {
    const firstWrite = deferred();
    const events: UnstampedMessageStreamEvent[] = [];
    const emitFn = vi.fn(async (event: UnstampedMessageStreamEvent) => {
      events.push(event);
      if (events.length === 1) await firstWrite.promise;
    });
    const emitter = createOrderedStreamEmitter(emitFn);
    const result = createActionResultEvent({
      result: { callId: "call_1", kind: "tool-result", output: "done", toolName: "progress" },
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    });

    await emitter.emit(partial("call_1", "first"));
    await emitter.emit(partial("call_1", "second"));
    await emitter.emit(partial("call_2", "first"));
    await emitter.emit(partial("call_2", "second"));
    await emitter.emit(result);
    await emitter.emit(partial("call_1", "late"));

    firstWrite.resolve();
    await emitter.closeAndDrain();

    expect(events).toEqual([
      partial("call_1", "first"),
      partial("call_1", "second"),
      partial("call_2", "second"),
      result,
      partial("call_1", "late"),
    ]);
  });

  it("surfaces sink failures from close and later emissions", async () => {
    const writeError = new Error("durable write failed");
    const emitter = createOrderedStreamEmitter(async () => {
      throw writeError;
    });

    await emitter.emit(message("A", 0));

    await expect(emitter.closeAndDrain()).rejects.toBe(writeError);
    await expect(emitter.emit(message("B", 1))).rejects.toBe(writeError);
  });

  it("rejects emissions after closing", async () => {
    const emitter = createOrderedStreamEmitter(async () => {});

    await emitter.closeAndDrain();

    await expect(emitter.emit(message("A", 0))).rejects.toThrow(/closed/);
  });

  it("counts merged empty deltas toward the pending-event limit", async () => {
    const firstWrite = deferred();
    const events: UnstampedMessageStreamEvent[] = [];
    const emitter = createOrderedStreamEmitter(
      async (event) => {
        events.push(event);
        if (events.length === 1) await firstWrite.promise;
      },
      { maxPendingEvents: 2 },
    );

    await emitter.emit(message("A", 0));
    await emitter.emit(reasoning("", 0));
    let accepted = false;
    const limited = emitter.emit(reasoning("", 0)).then(() => {
      accepted = true;
    });
    await Promise.resolve();

    expect(accepted).toBe(false);
    firstWrite.resolve();
    await limited;
    await emitter.closeAndDrain();
    expect(events).toEqual([message("A", 0), reasoning("", 0)]);
  });
});
