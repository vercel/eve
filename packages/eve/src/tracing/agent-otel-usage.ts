import type { Span } from "#compiled/@opentelemetry/api/index.js";

import type { InstrumentationUsage } from "#instrumentation/lifecycle.js";
import type { AgentTurnTraceState } from "#tracing/agent-trace-state.js";

/** Applies eve's structural token usage attributes to an agent span. */
export function setAgentUsage(span: Span, usage: InstrumentationUsage): void {
  if (usage.inputTokens !== undefined) {
    span.setAttribute("agent.usage.input_tokens", usage.inputTokens);
  }
  if (usage.outputTokens !== undefined) {
    span.setAttribute("agent.usage.output_tokens", usage.outputTokens);
  }
  const details = usage.inputTokenDetails;
  if (details?.cacheReadTokens !== undefined) {
    span.setAttribute("agent.usage.cache_read_tokens", details.cacheReadTokens);
  }
  if (details?.cacheWriteTokens !== undefined) {
    span.setAttribute("agent.usage.cache_write_tokens", details.cacheWriteTokens);
  }
}

/** Applies standard GenAI token usage while retaining eve's compatibility attributes. */
export function setGenAiUsage(span: Span, usage: InstrumentationUsage): void {
  setAgentUsage(span, usage);
  if (usage.inputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  }
  if (usage.outputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  }
  const details = usage.inputTokenDetails;
  if (details?.cacheReadTokens !== undefined) {
    span.setAttribute("gen_ai.usage.cache_read.input_tokens", details.cacheReadTokens);
  }
  if (details?.cacheWriteTokens !== undefined) {
    span.setAttribute("gen_ai.usage.cache_creation.input_tokens", details.cacheWriteTokens);
  }
}

export function setAgentInvocationUsage(
  span: Span,
  modelUsage: AgentTurnTraceState["modelUsage"],
): void {
  if (modelUsage === undefined) return;
  if (modelUsage.inputTokens !== undefined) {
    span.setAttribute("agent.usage.input_tokens", modelUsage.inputTokens);
  }
  if (modelUsage.outputTokens !== undefined) {
    span.setAttribute("agent.usage.output_tokens", modelUsage.outputTokens);
  }
}
