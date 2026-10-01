import { createTraceEngine } from "#tracing/core/engine.js";
import type {
  Attributes,
  CaptureDecision,
  DurableTraceBackend,
  PreparedSpan,
  TraceReference,
} from "#tracing/core/types.js";
import { withoutDeclinedContent } from "#tracing/content-attributes.js";

export interface DurableSpanRecord {
  readonly span: PreparedSpan;
  readonly reference: TraceReference;
  readonly capture: CaptureDecision;
}

export interface DurableSpanStore {
  get(key: string): Promise<DurableSpanRecord | undefined>;
  put(key: string, record: DurableSpanRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Persistence belongs to the caller; no span object crosses a worker boundary. */
export function createDurableTraceDriver(input: {
  readonly backend: DurableTraceBackend;
  readonly store: DurableSpanStore;
  readonly diagnostic?: (code: string) => void;
}) {
  const engine = createTraceEngine(input);
  return {
    async reserve(
      key: string,
      span: PreparedSpan,
      capture: CaptureDecision,
    ): Promise<DurableSpanRecord> {
      const previous = await input.store.get(key);
      if (previous !== undefined) return previous;
      span = {
        ...span,
        attributes: (withoutDeclinedContent(span.attributes, capture) ??
          span.attributes) as Attributes,
      };
      const reference = span.root
        ? input.backend.reserveActivation({ key, span, capture })
        : span.parent === undefined
          ? undefined
          : input.backend.reserveChild(span.parent, key);
      if (reference === undefined)
        throw new Error("A durable child span requires a parent trace reference.");
      const record: DurableSpanRecord = {
        span: {
          ...span,
          startTimeMs: span.startTimeMs ?? Date.now(),
        },
        reference,
        capture: { ...capture, emit: capture.emit && (reference.traceFlags & 1) !== 0 },
      };
      await input.store.put(key, record);
      return record;
    },
    async finish(
      key: string,
      result: {
        readonly attributes?: Attributes;
        readonly error?: unknown;
        readonly failed?: boolean;
        readonly event?: string;
        readonly endTimeMs?: number;
      },
    ): Promise<TraceReference | undefined> {
      const record = await input.store.get(key);
      if (record === undefined) return undefined;
      const operation = engine.startReserved(record.span, record.reference, record.capture);
      if (record.span.type === "activation")
        operation.addEvent("turn.started", undefined, record.span.startTimeMs);
      if (result.attributes !== undefined) engine.annotate(operation, result.attributes);
      if (result.event !== undefined) operation.addEvent(result.event, undefined, result.endTimeMs);
      if (result.failed) operation.fail(result.error);
      operation.end(result.endTimeMs);
      await input.store.delete(key);
      return record.reference;
    },
    async run<T>(record: DurableSpanRecord, execute: () => Promise<T>): Promise<T> {
      return input.backend.run(record.reference, record.capture, execute);
    },
  };
}
