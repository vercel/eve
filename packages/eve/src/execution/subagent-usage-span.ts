import { trace } from "#compiled/@opentelemetry/api/index.js";

import { createLogger } from "#internal/logging.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

const log = createLogger("execution.subagent-usage-span");

/**
 * Emits one caller-side `invoke_agent` span per successful delegated
 * subagent result that reports token usage, so the parent session's
 * observability can attribute a child agent's tokens. Runs in the
 * parent's turn step, so the span lands in the caller's trace.
 * Best-effort: a tracer failure never blocks the turn.
 */
export function recordSubagentUsageSpans(results: readonly RuntimeActionResult[]): void {
  for (const result of results) {
    if (result.kind !== "subagent-result" || result.isError === true) {
      continue;
    }
    const usage = result.usage;
    if (usage === undefined) {
      continue;
    }
    try {
      const span = trace.getTracer("eve").startSpan(`invoke_agent ${result.subagentName}`, {
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": result.subagentName,
          "gen_ai.usage.input_tokens": usage.inputTokens,
          "gen_ai.usage.output_tokens": usage.outputTokens,
          "gen_ai.usage.cache_read.input_tokens": usage.cacheReadTokens,
          "gen_ai.usage.cache_creation.input_tokens": usage.cacheWriteTokens,
        },
      });
      span.end();
    } catch (error) {
      log.warn("failed to emit subagent usage span", { error });
    }
  }
}
