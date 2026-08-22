import { TraceFlags, context, createContextKey } from "#compiled/@opentelemetry/api/index.js";
import type { SpanExporter, SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { createLogger, formatError } from "#internal/logging.js";

const log = createLogger("harness.batch-span-processor");

// This is the Symbol.for-backed key used by @opentelemetry/core's
// suppressTracing(), without pulling that package into eve's runtime.
const SUPPRESS_TRACING_KEY = createContextKey("OpenTelemetry SDK Context Key SUPPRESS_TRACING");

/** The OpenTelemetry specification's defaults for a batching processor. */
const DEFAULTS = {
  exportTimeoutMillis: 30_000,
  maxExportBatchSize: 512,
  maxQueueSize: 2048,
  scheduledDelayMillis: 5_000,
} as const;

/** @internal — exposed for tests; authors get the defaults. */
export interface BatchSpanProcessorOptions {
  readonly exportTimeoutMillis?: number;
  readonly maxExportBatchSize?: number;
  readonly maxQueueSize?: number;
  readonly scheduledDelayMillis?: number;
}

/**
 * Buffers ended spans and hands them to one exporter in batches.
 *
 * eve owns this rather than taking `@opentelemetry/sdk-trace-base` as a runtime
 * dependency: an exporter needs exactly one thing done for it, and the
 * dependency would arrive with the whole SDK behind it.
 *
 * A full queue drops the newest span rather than growing without bound. An
 * exporter that has stopped draining is already losing telemetry; taking the
 * agent's memory with it would turn that into an outage.
 */
export function batchSpanProcessor(
  exporter: SpanExporter,
  options: BatchSpanProcessorOptions = {},
): SpanProcessor {
  const exportTimeoutMillis = options.exportTimeoutMillis ?? DEFAULTS.exportTimeoutMillis;
  const maxExportBatchSize = options.maxExportBatchSize ?? DEFAULTS.maxExportBatchSize;
  const maxQueueSize = options.maxQueueSize ?? DEFAULTS.maxQueueSize;
  const scheduledDelayMillis = options.scheduledDelayMillis ?? DEFAULTS.scheduledDelayMillis;

  let buffer: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Exports are chained rather than raced so a flush cannot interleave two
  // batches into the same exporter.
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;

  function cancelTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function scheduleDrain(): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, scheduledDelayMillis);
    // Buffered spans must not be the reason a process stays alive; `shutdown`
    // is what settles them.
    timer.unref?.();
  }

  function drain(): Promise<void> {
    return waitForExporter(pendingDrain(), "span export").then(() => undefined);
  }

  async function exportBatch(batch: readonly unknown[]): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        try {
          context.with(context.active().setValue(SUPPRESS_TRACING_KEY, true), () => {
            exporter.export(batch, (result) => {
              if (result.code === 0) {
                resolve();
                return;
              }
              reject(result.error ?? new Error("Span export failed."));
            });
          });
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } catch (error: unknown) {
      // A destination that cannot take spans is not a reason to fail the turn
      // that produced them.
      log.warn("span export failed", { error: formatError(error) });
    }
  }

  return {
    async forceFlush() {
      if (stopped) return;
      const drained = await waitForExporter(pendingDrain(), "span export");
      if (!drained || exporter.forceFlush === undefined) return;
      await waitForExporter(
        settleExporter("exporter flush", exporter.forceFlush),
        "exporter flush",
      );
    },
    onEnd(span) {
      if (stopped) return;
      if (!isSampled(span)) return;
      if (buffer.length >= maxQueueSize) return;

      buffer.push(span);
      if (buffer.length >= maxExportBatchSize) {
        void drain();
        return;
      }
      scheduleDrain();
    },
    onStart() {},
    async shutdown() {
      stopped = true;
      const draining = pendingDrain();
      const drained = await waitForExporter(draining, "span export");
      if (!drained) {
        void draining.then(() => settleExporter("exporter shutdown", exporter.shutdown));
        return;
      }
      await waitForExporter(
        settleExporter("exporter shutdown", exporter.shutdown),
        "exporter shutdown",
      );
    },
  };

  function pendingDrain(): Promise<void> {
    cancelTimer();
    pending = pending.then(async () => {
      while (buffer.length > 0) {
        const batch = buffer.splice(0, maxExportBatchSize);
        await exportBatch(batch);
      }
    });
    return pending;
  }

  async function waitForExporter(operation: Promise<void>, name: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        log.warn(`${name} timed out; preserving exporter serialization`, {
          timeoutMillis: exportTimeoutMillis,
        });
        resolve(false);
      }, exportTimeoutMillis);
      timer.unref?.();
    });
    const completed = operation.then(() => true);
    try {
      return await Promise.race([completed, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function settleExporter(name: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation.call(exporter);
    } catch (error: unknown) {
      log.warn(`${name} failed`, { error: formatError(error) });
    }
  }
}

function isSampled(span: unknown): boolean {
  if (typeof span !== "object" || span === null || !("spanContext" in span)) return false;
  const spanContext = (span as { readonly spanContext?: unknown }).spanContext;
  if (typeof spanContext !== "function") return false;
  const context = Reflect.apply(spanContext, span, []) as { readonly traceFlags?: unknown };
  return (
    typeof context.traceFlags === "number" &&
    (context.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
  );
}
