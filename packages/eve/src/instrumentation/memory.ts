import type {
  InstrumentationContextRunner,
  InstrumentationHooks,
} from "#instrumentation/lifecycle.js";

/** Standard GenAI memory operations that eve can identify from its lifecycle. */
export type InstrumentationMemoryOperationName = "search_memory" | "upsert_memory";

/** One memory record in the OpenTelemetry GenAI memory-records shape. */
export interface InstrumentationMemoryRecord {
  readonly content: string;
  readonly id?: string;
}

/** Stable framework context for one memory operation. */
export interface InstrumentationMemoryOperation {
  readonly idempotencyKey: string;
  readonly operationName: InstrumentationMemoryOperationName;
  /**
   * The operation phase that caused eve to call the memory provider.
   *
   * This is eve-specific context; `operationName` is the corresponding
   * OpenTelemetry GenAI operation.
   */
  readonly phase: string;
  /** The path-derived memory slot. */
  readonly slot: string;
  /** The opaque memory scope key, used as eve's memory-store identifier. */
  readonly storeId: string;
  readonly turnId?: string;
}

/** Bound session identity added when eve publishes a memory operation. */
export interface InstrumentationMemoryOperationEvent extends InstrumentationMemoryOperation {
  readonly rootSessionId: string;
  readonly sessionId: string;
}

export interface InstrumentationMemoryOperationStartedEvent extends InstrumentationMemoryOperationEvent {
  readonly type: "memory.operation.started";
}

export interface InstrumentationMemoryOperationCompletedEvent extends InstrumentationMemoryOperationEvent {
  readonly type: "memory.operation.completed";
  /** The number of records the operation returned or changed, when known. */
  readonly recordCount?: number;
  /** Content. Absent unless this provider's trace policy records outputs. */
  readonly outputRecords?: readonly InstrumentationMemoryRecord[];
}

export interface InstrumentationMemoryOperationFailedEvent extends InstrumentationMemoryOperationEvent {
  readonly type: "memory.operation.failed";
  /** Content. Absent unless this provider's trace policy records outputs. */
  readonly error?: unknown;
}

export type InstrumentationMemoryOperationTerminalEvent =
  | InstrumentationMemoryOperationCompletedEvent
  | InstrumentationMemoryOperationFailedEvent;

export interface InstrumentationMemoryExecutionOperation {
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly type: "memory.operation";
}

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

export function createMemoryInstrumentation(input: {
  readonly resolveContext: () => {
    readonly hooks: InstrumentationHooks;
    readonly rootSessionId: string;
  };
  readonly runInContext: InstrumentationContextRunner;
  readonly sessionId: string;
}): MemoryInstrumentation {
  return {
    async execute(operation, execute) {
      const { hooks, rootSessionId } = input.resolveContext();
      const event = { ...operation, rootSessionId, sessionId: input.sessionId };
      await hooks.publish({ ...event, type: "memory.operation.started" });
      try {
        const result = await input.runInContext(
          {
            idempotencyKey: operation.idempotencyKey,
            sessionId: input.sessionId,
            turnId: operation.turnId,
            type: "memory.operation",
          },
          execute,
        );
        await hooks.publish({
          ...event,
          outputRecords: result.outputRecords,
          recordCount: result.recordCount,
          type: "memory.operation.completed",
        });
        return result.value;
      } catch (error) {
        await hooks.publish({ ...event, error, type: "memory.operation.failed" });
        throw error;
      }
    },
  };
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
