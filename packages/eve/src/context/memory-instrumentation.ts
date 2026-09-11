import { contextStorage, type AlsContext } from "#context/container.js";
import { MemoryInstrumentationKey } from "#context/keys.js";
import type {
  InstrumentationMemoryOperation,
  InstrumentationMemoryRecord,
} from "#instrumentation/lifecycle.js";

/** The terminal details a memory operation reports to instrumentation. */
export interface MemoryInstrumentationResult<T> {
  readonly value: T;
  readonly recordCount?: number;
  readonly recordId?: string;
  readonly outputRecords?: readonly InstrumentationMemoryRecord[];
}

/** Step-local bridge from memory code to the active instrumentation runtime. */
export interface MemoryInstrumentation {
  execute<T>(
    operation: InstrumentationMemoryOperation & {
      readonly inputRecords?: readonly InstrumentationMemoryRecord[];
    },
    execute: () => Promise<MemoryInstrumentationResult<T>>,
  ): Promise<T>;
}

/**
 * Runs one provider operation under eve's memory instrumentation when tracing
 * is active. Memory remains usable without tracing, including in direct tests.
 */
export async function instrumentMemoryOperation<T>(
  ctx: AlsContext,
  operation: InstrumentationMemoryOperation & {
    readonly inputRecords?: readonly InstrumentationMemoryRecord[];
  },
  execute: () => Promise<MemoryInstrumentationResult<T>>,
): Promise<T> {
  const instrumentation = ctx.get(MemoryInstrumentationKey);
  if (instrumentation === undefined) return (await execute()).value;
  return await instrumentation.execute(operation, execute);
}

/** Reads the active eve context when a memory tool executes inside a tool call. */
export async function instrumentCurrentMemoryOperation<T>(
  operation:
    | (InstrumentationMemoryOperation & {
        readonly inputRecords?: readonly InstrumentationMemoryRecord[];
      })
    | (() => InstrumentationMemoryOperation & {
        readonly inputRecords?: readonly InstrumentationMemoryRecord[];
      }),
  execute: () => Promise<MemoryInstrumentationResult<T>>,
): Promise<T> {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return (await execute()).value;
  const instrumentation = ctx.get(MemoryInstrumentationKey);
  if (instrumentation === undefined) return (await execute()).value;
  return await instrumentation.execute(
    typeof operation === "function" ? operation() : operation,
    execute,
  );
}
