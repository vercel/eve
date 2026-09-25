import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { Usage } from "./result.ts";

export interface UsageRecord {
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly cost?: number;
}

/**
 * Sums usage records from a JSON Lines log, skipping non-JSON diagnostics.
 * Returns undefined when the log is missing or holds no usage records. A zero
 * cost total is reported as unknown because harnesses without pricing data
 * report zero.
 */
export async function readJsonlUsage(
  path: string,
  extract: (event: unknown) => UsageRecord | undefined,
): Promise<Usage | undefined> {
  let records = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cost = 0;
  try {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.startsWith("{")) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const record = extract(event);
      if (!record) continue;
      records++;
      inputTokens += record.input;
      outputTokens += record.output;
      cachedTokens += record.cached;
      cost += record.cost ?? 0;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (records === 0) return undefined;
  return { inputTokens, outputTokens, cachedTokens, costUsd: cost > 0 ? cost : null };
}

export function count(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
