import { createHash } from "node:crypto";

import type { EveEvalTraceContext } from "#evals/types.js";

const DATADOG_LLMOBS_TRACE_ID_NAMESPACE = Buffer.from("f47ac10b58cc4372a5670e02b2c3d479", "hex");
const W3C_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const W3C_SPAN_ID_PATTERN = /^[0-9a-f]{16}$/iu;

/** Identifies one runtime trace by the IDs Datadog's APM-to-LLMObs indexer assigns. */
export interface ExperimentRuntimeTraceLink {
  readonly relation: "experiment_runtime";
  readonly traceId: string;
  readonly spanId: string;
  readonly sessionId: string;
  readonly primary: boolean;
}

/** Converts sampled runtime trace contexts to Datadog-indexed links; skips the rest. */
export function resolveRuntimeTraceLinks(
  traceContexts: readonly EveEvalTraceContext[],
): ExperimentRuntimeTraceLink[] {
  return traceContexts.flatMap((traceContext) => {
    if ((traceContext.traceFlags & 1) === 0) return [];
    const traceId = toDatadogLlmobsTraceId(traceContext.traceId);
    const spanId = toDatadogLlmobsSpanId(traceContext.spanId);
    if (traceId === undefined || spanId === undefined) return [];
    return [
      {
        relation: "experiment_runtime",
        traceId,
        spanId,
        sessionId: traceContext.sessionId,
        primary: traceContext.primary,
      },
    ];
  });
}

function toDatadogLlmobsTraceId(traceId: string): string | undefined {
  const canonicalTraceId = traceId.toLowerCase();
  if (!W3C_TRACE_ID_PATTERN.test(canonicalTraceId) || /^0+$/u.test(canonicalTraceId)) {
    return undefined;
  }

  // Datadog indexes OTel traces by their low 64 bits, then derives a UUIDv5-style LLMObs ID.
  const canonicalApmTraceId = canonicalTraceId.slice(-16).padStart(32, "0");
  const hash = createHash("sha1")
    .update(DATADOG_LLMOBS_TRACE_ID_NAMESPACE)
    .update(canonicalApmTraceId)
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return hash.toString("hex");
}

function toDatadogLlmobsSpanId(spanId: string): string | undefined {
  if (!W3C_SPAN_ID_PATTERN.test(spanId) || /^0+$/u.test(spanId)) return undefined;
  return BigInt(`0x${spanId}`).toString(10);
}
