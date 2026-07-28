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

/** Persists spans from agent-owned traces as immutable OTLP/JSON segments. */
export class LocalTraceSpanProcessor implements SpanProcessor {
  readonly #appRoot: string;
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

    this.#queue = this.#queue
      .then(async () => {
        const directory = join(this.#appRoot, ".eve", "traces", "v1", traceId, "segments");
        await mkdir(directory, { recursive: true });
        await atomicWriteFile(join(directory, `${spanId}.otlp.json`), payload);
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
