import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import { isCompactionDefinition } from "#shared/compaction-definition.js";

export function normalizeCompactionDefinition(value: unknown, message: string): CompactionStrategy {
  if (!isCompactionDefinition(value)) throw new Error(message);
  const record = value as Record<string, unknown>;
  for (const method of ["shouldCompact", "compact"] as const) {
    if (typeof record[method] !== "function") {
      throw new Error(`${message} "${method}" must be a function.`);
    }
  }
  return value as CompactionStrategy;
}
