import type { SpanExporter } from "#compiled/@vercel/otel/index.js";
import { context, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { isTracingSuppressed } from "@opentelemetry/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { batchSpanProcessor } from "#tracing/batch-span-processor.js";

interface RecordingExporter extends SpanExporter {
  readonly batches: readonly (readonly unknown[])[];
}

function recordingExporter(behavior: { readonly fail?: boolean } = {}): RecordingExporter {
  const batches: (readonly unknown[])[] = [];
  return {
    batches,
    export: (spans, resultCallback) => {
      batches.push([...spans]);
      resultCallback(
        behavior.fail === true ? { code: 1, error: new Error("refused") } : { code: 0 },
      );
    },
    shutdown: async () => undefined,
  };
}

function span(index: number, traceFlags: TraceFlags = TraceFlags.SAMPLED): unknown {
  return { index, spanContext: () => ({ traceFlags }) };
}

function batchIndexes(batches: readonly (readonly unknown[])[]): number[][] {
  return batches.map((batch) => batch.map((item) => (item as { readonly index: number }).index));
}

describe("batchSpanProcessor", () => {
  afterEach(() => {
    vi.useRealTimers();
    context.disable();
  });

  it("exports once the batch size is reached, without waiting for the timer", async () => {
    const exporter = recordingExporter();
    const processor = batchSpanProcessor(exporter, {
      maxExportBatchSize: 2,
      scheduledDelayMillis: 60_000,
    });

    processor.onEnd(span(1));
    expect(exporter.batches).toHaveLength(0);

    processor.onEnd(span(2));
    await processor.forceFlush();

    expect(batchIndexes(exporter.batches)).toStrictEqual([[1, 2]]);
  });

  it("splits a flush larger than one batch", async () => {
    const exporter = recordingExporter();
    const processor = batchSpanProcessor(exporter, { maxExportBatchSize: 2 });

    for (const index of [1, 2, 3]) processor.onEnd(span(index));
    await processor.forceFlush();

    expect(batchIndexes(exporter.batches)).toStrictEqual([[1, 2], [3]]);
  });

  // An exporter that has stopped draining is already losing telemetry; taking
  // the agent's memory with it would turn that into an outage.
  it("drops spans past the queue limit rather than growing without bound", async () => {
    const exporter = recordingExporter();
    const processor = batchSpanProcessor(exporter, {
      maxExportBatchSize: 100,
      maxQueueSize: 2,
    });

    for (const index of [1, 2, 3, 4]) processor.onEnd(span(index));
    await processor.forceFlush();

    expect(batchIndexes(exporter.batches)).toStrictEqual([[1, 2]]);
  });

  it("logs a refused export rather than failing the turn that produced it", async () => {
    const processor = batchSpanProcessor(recordingExporter({ fail: true }), {
      maxExportBatchSize: 1,
    });

    processor.onEnd(span(1));
    await expect(processor.forceFlush()).resolves.toBeUndefined();
  });

  it("exports only sampled spans", async () => {
    const exporter = recordingExporter();
    const processor = batchSpanProcessor(exporter);

    processor.onEnd(span(1, TraceFlags.NONE));
    processor.onEnd(span(2));
    await processor.forceFlush();

    expect(batchIndexes(exporter.batches)).toStrictEqual([[2]]);
  });

  it("suppresses tracing while an exporter runs", async () => {
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    const suppressed: boolean[] = [];
    const exporter: SpanExporter = {
      export: (_spans, resultCallback) => {
        suppressed.push(isTracingSuppressed(context.active()));
        resultCallback({ code: 0 });
      },
      shutdown: async () => undefined,
    };
    const processor = batchSpanProcessor(exporter);

    processor.onEnd(span(1));
    await processor.forceFlush();

    expect(suppressed).toEqual([true]);
    expect(isTracingSuppressed(context.active())).toBe(false);
    manager.disable();
  });

  it("does not overlap a later batch after the first times out", async () => {
    vi.useFakeTimers();
    const batches: (readonly unknown[])[] = [];
    const callbacks: Array<(result: { code: number }) => void> = [];
    const exporter: SpanExporter = {
      export: (spans, resultCallback) => {
        batches.push([...spans]);
        callbacks.push(resultCallback);
      },
      shutdown: async () => undefined,
    };
    const processor = batchSpanProcessor(exporter, {
      exportTimeoutMillis: 10,
      maxExportBatchSize: 1,
    });

    processor.onEnd(span(1));
    await vi.advanceTimersByTimeAsync(0);
    processor.onEnd(span(2));
    const flushed = processor.forceFlush();
    let flushSettled = false;
    void flushed.then(() => {
      flushSettled = true;
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(batchIndexes(batches)).toStrictEqual([[1]]);
    expect(flushSettled).toBe(true);
    callbacks[0]?.({ code: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(batchIndexes(batches)).toStrictEqual([[1], [2]]);
    callbacks[1]?.({ code: 0 });
    await flushed;
  });

  it("continues exporting after exporter forceFlush times out", async () => {
    vi.useFakeTimers();
    const exporter = recordingExporter() as RecordingExporter & {
      forceFlush: () => Promise<void>;
    };
    exporter.forceFlush = () => new Promise(() => {});
    const processor = batchSpanProcessor(exporter, {
      exportTimeoutMillis: 10,
      maxExportBatchSize: 1,
    });

    processor.onEnd(span(1));
    const flushed = processor.forceFlush();
    await vi.advanceTimersByTimeAsync(10);
    await flushed;

    processor.onEnd(span(2));
    await vi.advanceTimersByTimeAsync(0);

    expect(batchIndexes(exporter.batches)).toStrictEqual([[1], [2]]);
  });

  it("drains queued batches and closes the exporter after shutdown times out", async () => {
    vi.useFakeTimers();
    const batches: (readonly unknown[])[] = [];
    const callbacks: Array<(result: { code: number }) => void> = [];
    const shutdown = vi.fn(async () => undefined);
    const exporter: SpanExporter = {
      export: (spans, resultCallback) => {
        batches.push([...spans]);
        callbacks.push(resultCallback);
      },
      shutdown,
    };
    const processor = batchSpanProcessor(exporter, {
      exportTimeoutMillis: 10,
      maxExportBatchSize: 1,
    });

    processor.onEnd(span(1));
    await vi.advanceTimersByTimeAsync(0);
    processor.onEnd(span(2));
    const stopped = processor.shutdown();
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
    expect(shutdown).not.toHaveBeenCalled();

    callbacks[0]?.({ code: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(batchIndexes(batches)).toStrictEqual([[1], [2]]);
    callbacks[1]?.({ code: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("drains and then closes the exporter on shutdown, and takes nothing after", async () => {
    const exporter = recordingExporter();
    const shutdown = vi.spyOn(exporter, "shutdown");
    const processor = batchSpanProcessor(exporter, { scheduledDelayMillis: 60_000 });

    processor.onEnd(span(1));
    await processor.shutdown();
    processor.onEnd(span(2));
    await processor.forceFlush();

    expect(batchIndexes(exporter.batches)).toStrictEqual([[1]]);
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
