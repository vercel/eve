import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import { isCompactionDefinition } from "#shared/compaction-definition.js";

export function normalizeCompactionDefinition(value: unknown, message: string): CompactionStrategy {
  if (!isCompactionDefinition(value)) throw new Error(message);
  const record = value as Record<string, unknown>;
  if (typeof record.compact !== "function") {
    throw new Error(`${message} "compact" must be a function.`);
  }
  return value as CompactionStrategy;
}
