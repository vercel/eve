import { join } from "node:path";

import type { Usage } from "../../core/result.ts";
import { count, readJsonlUsage, record, type UsageRecord } from "../../core/usage.ts";

/** Sums `step.completed` usage from the runner's incrementally written event log. */
export function readEveUsage(agentLogsDir: string): Promise<Usage | undefined> {
  return readJsonlUsage(join(agentLogsDir, "events.ndjson"), eveStepUsage);
}

export function eveStepUsage(event: unknown): UsageRecord | undefined {
  const value = record(event);
  if (value.type !== "step.completed") return undefined;
  const data = record(value.data);
  const usage = record(data.usage ?? data);
  return {
    input: count(usage.inputTokens, usage.input_tokens),
    output: count(usage.outputTokens, usage.output_tokens),
    cached: count(usage.cacheReadTokens, usage.cachedTokens, usage.cached_tokens),
    cost: count(usage.costUsd, usage.cost_usd),
  };
}
