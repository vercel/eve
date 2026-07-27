import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { JsonTraceSerializer } from "#compiled/@opentelemetry/otlp-transformer/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { createLogger, formatError } from "#internal/logging.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";

interface ReadableSpanLike {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly instrumentationScope?: { readonly name?: string };
  readonly spanContext: () => { readonly spanId: string; readonly traceId: string };
}

const log = createLogger("harness.local-trace-span-processor");

/** Persists spans from agent-owned traces as immutable OTLP/JSON segments. */
export class LocalTraceSpanProcessor implements SpanProcessor {
  readonly #appRoot: string;
  readonly #ownedTraceIds = new Set<string>();
  #failed = false;
  #queue = Promise.resolve();

  constructor(appRoot: string) {
    this.#appRoot = appRoot;
  }

  forceFlush(): Promise<void> {
    return this.#queue;
  }

  onStart(span: unknown): void {
    if (!isReadableSpan(span)) return;
    if (typeof span.attributes["agent.session.id"] === "string") {
      this.#ownedTraceIds.add(span.spanContext().traceId);
    }
  }

  onEnd(span: unknown): void {
    if (this.#failed || !isReadableSpan(span)) return;
    if (span.instrumentationScope?.name === "workflow") return;
    const { spanId, traceId } = span.spanContext();
    if (!this.#ownedTraceIds.has(traceId) || !isHexId(traceId, 32) || !isHexId(spanId, 16)) return;
    const payload = JsonTraceSerializer.serializeRequest([span]);
    if (payload === undefined) return;

    this.#queue = this.#queue
      .then(async () => {
        const directory = join(this.#appRoot, ".eve", "traces", "v1", traceId, "segments");
        await mkdir(directory, { mode: 0o700, recursive: true });
        await chmod(directory, 0o700);
        await atomicWriteFile(join(directory, `${spanId}.otlp.json`), payload);
      })
      .catch((error: unknown) => {
        this.#failed = true;
        log.warn("local trace persistence failed", { error: formatError(error) });
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
