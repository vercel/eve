import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { JsonTraceSerializer } from "#compiled/@opentelemetry/otlp-transformer/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { createLogger, formatError } from "#internal/logging.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";
import { indexLocalTraceConversation } from "#tracing/local-trace-discovery-index.js";

interface ReadableSpanLike {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly spanContext: () => { readonly spanId: string; readonly traceId: string };
}

const log = createLogger("harness.local-trace-span-processor");

const LOCAL_TRACE_SCHEMA_DIRECTORY = "v1";
const LOCAL_TRACE_SEGMENTS_DIRECTORY = "segments";

function resolveLocalTraceStoreDirectory(appRoot: string): string {
  return join(appRoot, ".eve", "traces");
}

/** Resolves the directory holding one trace per subdirectory. */
export function resolveLocalTraceSchemaDirectory(appRoot: string): string {
  return join(resolveLocalTraceStoreDirectory(appRoot), LOCAL_TRACE_SCHEMA_DIRECTORY);
}

function resolveLocalTraceDirectory(appRoot: string, traceId: string): string {
  return join(resolveLocalTraceSchemaDirectory(appRoot), traceId);
}

/**
 * Resolves the directory holding one trace's span segments.
 *
 * Segments are added, never rewritten, so this directory's mtime is the instant
 * the trace last received a span.
 */
export function resolveLocalTraceSegmentsDirectory(appRoot: string, traceId: string): string {
  return join(resolveLocalTraceDirectory(appRoot, traceId), LOCAL_TRACE_SEGMENTS_DIRECTORY);
}

/** Persists spans from agent-owned traces as immutable OTLP/JSON segments. */
export class LocalTraceSpanProcessor implements SpanProcessor {
  readonly #appRoot: string;
  readonly #indexedConversations = new Set<string>();
  #queue = Promise.resolve();
  #reportedFailure = false;

  constructor(appRoot: string) {
    this.#appRoot = appRoot;
  }

  forceFlush(): Promise<void> {
    return this.#queue;
  }

  onStart(): void {}

  onEnd(span: unknown): void {
    if (!isReadableSpan(span)) return;
    const { spanId, traceId } = span.spanContext();
    if (!isHexId(traceId, 32) || !isHexId(spanId, 16)) return;
    const payload = JsonTraceSerializer.serializeRequest([span]);
    if (payload === undefined) return;
    const recordedConversationId = span.attributes["gen_ai.conversation.id"];
    const conversationId =
      typeof recordedConversationId === "string" && recordedConversationId.length > 0
        ? recordedConversationId
        : undefined;
    const indexKey = conversationId === undefined ? undefined : `${traceId}\0${conversationId}`;

    this.#queue = this.#queue
      .then(async () => {
        const traceDirectory = resolveLocalTraceDirectory(this.#appRoot, traceId);
        const segmentsDirectory = resolveLocalTraceSegmentsDirectory(this.#appRoot, traceId);
        await mkdir(segmentsDirectory, { recursive: true });
        await atomicWriteFile(join(segmentsDirectory, `${spanId}.otlp.json`), payload);
        if (
          conversationId !== undefined &&
          indexKey !== undefined &&
          !this.#indexedConversations.has(indexKey)
        ) {
          await indexLocalTraceConversation({ conversationId, traceDirectory });
          this.#indexedConversations.add(indexKey);
        }
      })
      .catch((error: unknown) => {
        if (!this.#reportedFailure) {
          this.#reportedFailure = true;
          log.warn("local trace persistence failed", { error: formatError(error) });
        }
      });
  }

  shutdown(): Promise<void> {
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
