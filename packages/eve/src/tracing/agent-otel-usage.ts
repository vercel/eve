import type { Span } from "#compiled/@opentelemetry/api/index.js";

import type { InstrumentationUsage } from "#instrumentation/lifecycle.js";

/** Applies eve's structural token usage attributes to an agent span. */
export function setAgentUsage(
  span: Span,
  usage: InstrumentationUsage,
  options: { readonly includeGenAiDetails?: boolean } = {},
): void {
  const includeGenAiDetails = options.includeGenAiDetails !== false;
  if (usage.inputTokens !== undefined) {
    span.setAttribute("agent.usage.input_tokens", usage.inputTokens);
    if (includeGenAiDetails) {
      span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
    }
  }
  if (usage.outputTokens !== undefined) {
    span.setAttribute("agent.usage.output_tokens", usage.outputTokens);
    if (includeGenAiDetails) {
      span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
    }
  }
  const details = usage.inputTokenDetails;
  if (details?.cacheReadTokens !== undefined) {
    if (!includeGenAiDetails) {
      span.setAttribute("agent.usage.cache_read_tokens", details.cacheReadTokens);
    } else {
      span.setAttribute("gen_ai.usage.cache_read.input_tokens", details.cacheReadTokens);
    }
  }
  if (details?.cacheWriteTokens !== undefined) {
    if (!includeGenAiDetails) {
      span.setAttribute("agent.usage.cache_write_tokens", details.cacheWriteTokens);
    } else {
      span.setAttribute("gen_ai.usage.cache_write.input_tokens", details.cacheWriteTokens);
    }
  }
}
