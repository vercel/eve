import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { JsonTraceSerializer } from "#compiled/@opentelemetry/otlp-transformer/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { createLogger, formatError } from "#internal/logging.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";

interface ReadableSpanLike {
  readonly spanContext: () => { readonly spanId: string; readonly traceId: string };
}

const log = createLogger("harness.local-trace-span-processor");

const LOCAL_TRACE_SCHEMA_DIRECTORY = "v1";
const LOCAL_TRACE_SEGMENTS_DIRECTORY = "segments";
export const LOCAL_TRACE_PENDING_SPANS = 2048;
export const LOCAL_TRACE_PENDING_BYTES = 8 * 1024 * 1024;
export const LOCAL_TRACE_SEGMENT_BYTES = 1024 * 1024;

function resolveLocalTraceStoreDirectory(appRoot: string): string {
  return join(appRoot, ".eve", "traces");
}

/** Resolves the directory holding one trace per subdirectory. */
export function resolveLocalTraceSchemaDirectory(appRoot: string): string {
  return join(resolveLocalTraceStoreDirectory(appRoot), LOCAL_TRACE_SCHEMA_DIRECTORY);
}

/**
 * Resolves the directory holding one trace's span segments.
 *
 * Segments are added, never rewritten, so this directory's mtime is the instant
 * the trace last received a span.
 */
export function resolveLocalTraceSegmentsDirectory(appRoot: string, traceId: string): string {
  return join(resolveLocalTraceSchemaDirectory(appRoot), traceId, LOCAL_TRACE_SEGMENTS_DIRECTORY);
}

/** Persists spans from agent-owned traces as immutable OTLP/JSON segments. */
export class LocalTraceSpanProcessor implements SpanProcessor {
  readonly #appRoot: string;
  #queue = Promise.resolve();
  #reportedFailure = false;
  #pendingBytes = 0;
  #pendingSpans = 0;
  #droppedSpans = 0;
  #stopped = false;

  constructor(appRoot: string) {
    this.#appRoot = appRoot;
  }

  forceFlush(): Promise<void> {
    if (this.#droppedSpans > 0) {
      log.warn("local trace spans dropped at the persistence budget", {
        droppedSpans: this.#droppedSpans,
      });
      this.#droppedSpans = 0;
    }
    return this.#queue;
  }

  onStart(): void {}

  onEnd(span: unknown): void {
    if (this.#stopped) return;
    if (
      this.#pendingSpans >= LOCAL_TRACE_PENDING_SPANS ||
      this.#pendingBytes >= LOCAL_TRACE_PENDING_BYTES
    ) {
      this.#droppedSpans += 1;
      return;
    }
    if (!isReadableSpan(span)) return;
    const { spanId, traceId } = span.spanContext();
    if (!isHexId(traceId, 32) || !isHexId(spanId, 16)) return;
    const payload = JsonTraceSerializer.serializeRequest([span]);
    if (payload === undefined) return;
    if (
      payload.byteLength > LOCAL_TRACE_SEGMENT_BYTES ||
      this.#pendingBytes + payload.byteLength > LOCAL_TRACE_PENDING_BYTES
    ) {
      this.#droppedSpans += 1;
      return;
    }
    this.#pendingBytes += payload.byteLength;
    this.#pendingSpans += 1;

    this.#queue = this.#queue
      .then(async () => {
        const directory = resolveLocalTraceSegmentsDirectory(this.#appRoot, traceId);
        await mkdir(directory, { recursive: true });
        await atomicWriteFile(join(directory, `${spanId}.otlp.json`), payload);
      })
      .catch((error: unknown) => {
        if (!this.#reportedFailure) {
          this.#reportedFailure = true;
          log.warn("local trace persistence failed", { error: formatError(error) });
        }
      })
      .finally(() => {
        this.#pendingBytes -= payload.byteLength;
        this.#pendingSpans -= 1;
      });
  }

  shutdown(): Promise<void> {
    this.#stopped = true;
    return this.forceFlush();
  }
}

function isReadableSpan(value: unknown): value is ReadableSpanLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "attributes" in value &&
    "spanContext" in value &&
    typeof value.spanContext === "function"
  );
}

function isHexId(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/u.test(value);
}
