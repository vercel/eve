import type {
  InstrumentationMemoryOperation,
  InstrumentationMemoryRecord,
} from "#instrumentation/lifecycle.js";

/** The terminal details a memory operation reports to instrumentation. */
export interface MemoryInstrumentationResult<T> {
  readonly value: T;
  readonly recordCount?: number;
  readonly outputRecords?: readonly InstrumentationMemoryRecord[];
}

/** Runtime bridge from memory providers to the active instrumentation pipeline. */
export interface MemoryInstrumentation {
  execute<T>(
    operation: InstrumentationMemoryOperation,
    execute: () => Promise<MemoryInstrumentationResult<T>>,
  ): Promise<T>;
}

/** Runs one provider operation under memory instrumentation, when installed. */
export async function instrumentMemoryOperation<T>(
  instrumentation: MemoryInstrumentation | undefined,
  operation: InstrumentationMemoryOperation | (() => InstrumentationMemoryOperation),
  execute: () => Promise<MemoryInstrumentationResult<T>>,
): Promise<T> {
  if (instrumentation === undefined) return (await execute()).value;
  return await instrumentation.execute(
    typeof operation === "function" ? operation() : operation,
    execute,
  );
}
