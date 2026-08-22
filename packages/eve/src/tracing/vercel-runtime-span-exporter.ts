import { JsonTraceSerializer } from "#compiled/@opentelemetry/otlp-transformer/index.js";
import { TraceFlags } from "#compiled/@opentelemetry/api/index.js";
import type { SpanExporter, SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { createLogger, formatError } from "#internal/logging.js";

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const log = createLogger("tracing.vercel-runtime-span-exporter");

interface VercelRequestContextReader {
  get():
    | {
        readonly telemetry?: { readonly reportSpans: (data: unknown) => void };
      }
    | undefined;
}

/** The request-context transport behind @vercel/otel's automatic processor. */
export function vercelRuntimeSpanExporter(): SpanExporter {
  return {
    export(spans, resultCallback) {
      const reader = (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] as
        | VercelRequestContextReader
        | undefined;
      const telemetry = reader?.get()?.telemetry;
      if (telemetry === undefined) {
        resultCallback({ code: 0 });
        return;
      }

      try {
        const serialized = JsonTraceSerializer.serializeRequest([...spans]);
        if (serialized === undefined) throw new Error("Failed to serialize spans.");
        telemetry.reportSpans(JSON.parse(new TextDecoder().decode(serialized)) as unknown);
        resultCallback({ code: 0 });
      } catch (error: unknown) {
        resultCallback({
          code: 1,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
    forceFlush: async () => undefined,
    shutdown: async () => undefined,
  };
}

/** Reports immediately so the span stays attached to its request context. */
export function vercelRuntimeSpanProcessor(): SpanProcessor {
  const exporter = vercelRuntimeSpanExporter();
  let stopped = false;
  return {
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
    onEnd(span) {
      if (stopped || !isSampled(span)) return;
      exporter.export([span], (result) => {
        if (result.code !== 0) {
          log.warn("Agent Runs export failed", {
            error: formatError(result.error ?? new Error("Span export failed.")),
          });
        }
      });
    },
    onStart() {},
    async shutdown() {
      stopped = true;
      await exporter.shutdown();
    },
  };
}

function isSampled(span: unknown): boolean {
  if (typeof span !== "object" || span === null || !("spanContext" in span)) return false;
  const spanContext = (span as { readonly spanContext?: unknown }).spanContext;
  if (typeof spanContext !== "function") return false;
  const value = Reflect.apply(spanContext, span, []) as { readonly traceFlags?: unknown };
  return (
    typeof value.traceFlags === "number" &&
    (value.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
  );
}
