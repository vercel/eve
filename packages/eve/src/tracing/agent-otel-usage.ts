import type { Span } from "#compiled/@opentelemetry/api/index.js";

import type { InstrumentationUsage } from "#instrumentation/lifecycle.js";

/** Applies token usage using one structural or GenAI attribute namespace. */
export function setSpanUsage(
  span: Span,
  usage: InstrumentationUsage,
  namespace: "agent" | "gen_ai",
): void {
  const prefix = `${namespace}.usage`;
  if (usage.inputTokens !== undefined) {
    span.setAttribute(`${prefix}.input_tokens`, usage.inputTokens);
  }
  if (usage.outputTokens !== undefined) {
    span.setAttribute(`${prefix}.output_tokens`, usage.outputTokens);
  }
  const details = usage.inputTokenDetails;
  if (details?.cacheReadTokens !== undefined) {
    const key = namespace === "agent" ? "cache_read_tokens" : "cache_read.input_tokens";
    span.setAttribute(`${prefix}.${key}`, details.cacheReadTokens);
  }
  if (details?.cacheWriteTokens !== undefined) {
    const key = namespace === "agent" ? "cache_write_tokens" : "cache_write.input_tokens";
    span.setAttribute(`${prefix}.${key}`, details.cacheWriteTokens);
  }
}
