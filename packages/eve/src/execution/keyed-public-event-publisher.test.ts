import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

const { appendKeyedStreamChunk, getStepMetadata } = vi.hoisted(() => ({
  appendKeyedStreamChunk: vi.fn(),
  getStepMetadata: vi.fn(() => ({ attempt: 1, stepId: "step-a" })),
}));

const { getDeserializeStream, getSerializeStream } = vi.hoisted(() => ({
  getDeserializeStream: vi.fn(),
  getSerializeStream: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", () => ({
  appendKeyedStreamChunk,
  getStepMetadata,
}));

vi.mock("#compiled/@workflow/core/serialization.js", () => ({
  getDeserializeStream,
  getSerializeStream,
}));

import {
  KeyedPublicEventCompatibilityError,
  KeyedPublicEventDivergenceError,
  createKeyedPublicEventPublisher,
} from "#execution/keyed-public-event-publisher.js";

afterEach(() => {
  appendKeyedStreamChunk.mockReset();
  getStepMetadata.mockReset();
  getStepMetadata.mockReturnValue({ attempt: 1, stepId: "step-a" });
});

beforeEach(() => {
  getDeserializeStream.mockImplementation(
    () =>
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk.subarray(4));
        },
      }),
  );
  getSerializeStream.mockImplementation(
    () =>
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const framed = new Uint8Array(chunk.length + 4);
          new DataView(framed.buffer).setUint32(0, chunk.length, false);
          framed.set(chunk, 4);
          controller.enqueue(framed);
        },
      }),
  );
});

const event = (text: string): UnstampedMessageStreamEvent => ({
  data: {
    messageDelta: text,
    messageSoFar: text,
    sequence: 1,
    stepIndex: 0,
    turnId: "turn-1",
  },
  type: "message.appended",
});

function parentWritable(): WritableStream<Uint8Array> {
  const writable = new WritableStream<Uint8Array>();
  Object.defineProperties(writable, {
    [Symbol.for("WORKFLOW_STREAM_NAME")]: { value: "stream-a" },
    [Symbol.for("WORKFLOW_STREAM_SERVER_RUN_ID")]: { value: "run-a" },
  });
  return writable;
}

function canonical(event: UnstampedMessageStreamEvent): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({ ...event, meta: { at: "2026-08-14T00:00:00.000Z", id: "evt_01" } })}\n`,
  );
}

describe("keyed public event publisher", () => {
  it("reuses one versioned key across retries despite a changing Workflow attempt", async () => {
    appendKeyedStreamChunk.mockResolvedValue({
      canonicalChunk: canonical(event("hello")),
      index: 4,
      inserted: true,
    });
    const first = createKeyedPublicEventPublisher({ parentWritable: parentWritable(), sessionId: "sess-a" });
    await first.publish(event("hello"));

    getStepMetadata.mockReturnValueOnce({ attempt: 2, stepId: "step-a" });
    appendKeyedStreamChunk.mockResolvedValueOnce({
      canonicalChunk: canonical(event("hello")),
      index: 4,
      inserted: false,
    });
    const retry = createKeyedPublicEventPublisher({ parentWritable: parentWritable(), sessionId: "sess-a" });
    await retry.publish(event("hello"));

    expect(appendKeyedStreamChunk.mock.calls.map((call) => call[2].idempotencyKey)).toEqual([
      "eve-public-event/v1/sess-a/step-a/0",
      "eve-public-event/v1/sess-a/step-a/0",
    ]);
    expect(getSerializeStream).toHaveBeenCalledTimes(2);
    const framedChunk = appendKeyedStreamChunk.mock.calls[0]?.[2].chunk;
    expect(framedChunk).toBeDefined();
    expect(new DataView(framedChunk!.buffer, framedChunk!.byteOffset, 4).getUint32(0, false)).toBe(
      framedChunk!.length - 4,
    );
  });

  it("gives equal events distinct ordinals within one step", async () => {
    appendKeyedStreamChunk.mockResolvedValue({
      canonicalChunk: canonical(event("same")),
      index: 0,
      inserted: true,
    });
    const publisher = createKeyedPublicEventPublisher({ parentWritable: parentWritable(), sessionId: "sess-a" });

    await publisher.publish(event("same"));
    await publisher.publish(event("same"));

    expect(appendKeyedStreamChunk.mock.calls.map((call) => call[2].idempotencyKey)).toEqual([
      "eve-public-event/v1/sess-a/step-a/0",
      "eve-public-event/v1/sess-a/step-a/1",
    ]);
  });

  it("adopts the first canonical metadata and runs effects only for its insertion", async () => {
    appendKeyedStreamChunk.mockResolvedValueOnce({
      canonicalChunk: canonical(event("hello")),
      index: 3,
      inserted: false,
    });
    const publisher = createKeyedPublicEventPublisher({ parentWritable: parentWritable(), sessionId: "sess-a" });
    const effect = vi.fn();

    const result = await publisher.publish(event("hello"));
    if (result.inserted) await effect(result.event);

    expect(result.event.meta).toEqual({ at: "2026-08-14T00:00:00.000Z", id: "evt_01" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("decodes a framed canonical receipt before preserving its first metadata", async () => {
    const rawCanonical = canonical(event("hello"));
    const framedCanonical = new Uint8Array(rawCanonical.length + 4);
    new DataView(framedCanonical.buffer).setUint32(0, rawCanonical.length, false);
    framedCanonical.set(rawCanonical, 4);
    appendKeyedStreamChunk.mockResolvedValue({
      canonicalChunk: framedCanonical,
      index: 3,
      inserted: false,
    });

    const publisher = createKeyedPublicEventPublisher({ parentWritable: parentWritable(), sessionId: "sess-a" });

    await expect(publisher.publish(event("hello"))).resolves.toMatchObject({
      event: { meta: { at: "2026-08-14T00:00:00.000Z", id: "evt_01" } },
      inserted: false,
    });
    expect(getDeserializeStream).toHaveBeenCalledTimes(1);
  });

  it("rejects a divergent canonical receipt at the occupied logical position", async () => {
    appendKeyedStreamChunk.mockResolvedValue({
      canonicalChunk: canonical(event("different")),
      index: 0,
      inserted: false,
    });
    const publisher = createKeyedPublicEventPublisher({ parentWritable: parentWritable(), sessionId: "sess-a" });

    await expect(publisher.publish(event("expected"))).rejects.toBeInstanceOf(
      KeyedPublicEventDivergenceError,
    );
  });

  it("fails closed before an append when the parent stream lacks the keyed identity", async () => {
    const publisher = createKeyedPublicEventPublisher({
      parentWritable: new WritableStream<Uint8Array>(),
      sessionId: "sess-a",
    });

    await expect(publisher.publish(event("hello"))).rejects.toBeInstanceOf(
      KeyedPublicEventCompatibilityError,
    );
    expect(appendKeyedStreamChunk).not.toHaveBeenCalled();
  });

  it("does not fall back to an ordinary write when a Vercel-style World rejects keyed append", async () => {
    const write = vi.fn();
    const writable = parentWritable();
    const originalGetWriter = writable.getWriter.bind(writable);
    vi.spyOn(writable, "getWriter").mockImplementation(() => {
      const writer = originalGetWriter();
      return Object.assign(writer, { write });
    });
    appendKeyedStreamChunk.mockRejectedValue(
      new Error("Keyed stream append v1 is unavailable for this Workflow World"),
    );
    const publisher = createKeyedPublicEventPublisher({ parentWritable: writable, sessionId: "sess-a" });

    await expect(publisher.publish(event("hello"))).rejects.toThrow(/keyed stream append v1 is unavailable/i);
    expect(write).not.toHaveBeenCalled();
  });
});
