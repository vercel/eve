import { randomUUID } from "node:crypto";
import { otelTelemetry } from "./adapters/otel.js";
import { aiSdkContentSerializer } from "./adapters/serialization.js";
import { createScopes, type LiveOperation } from "./core/scopes.js";
import { currentAgentHandoff } from "./core/delegation.js";
import { intersectCapture } from "./core/activation.js";
import { traceSnapshot } from "./core/snapshot.js";
import { operationHandle, wrappedOperation, type TurnOperation } from "./operations.js";
import type {
  AgentTelemetry,
  Attributes,
  CaptureDecision,
  ContentSerializer,
  ExecutionContext,
  FrameworkIdentity,
  RunIdentity,
  ScopeRecord,
  TraceCheckpointer,
  TraceErrorHandler,
  TraceLink,
  TraceReference,
} from "./core/types.js";

export interface AgentTracingOptions {
  /** Span output and context propagation. Defaults to the global OpenTelemetry provider. */
  readonly telemetry?: AgentTelemetry;
  /**
   * Makes turns durable. Each in-flight turn is saved under a library-chosen
   * key and removed when the turn and its open tool calls complete. Calling
   * `turn()` again with the same identity, in this or a later process,
   * continues the saved turn.
   */
  readonly checkpointer?: TraceCheckpointer;
  /** Defaults to the AI SDK content serializer. */
  readonly serializer?: ContentSerializer;
  readonly onError?: TraceErrorHandler;
}

export interface TurnInput {
  readonly identity: RunIdentity;
  /** Names the invocation span. Omit for an anonymous agent. */
  readonly agentName?: string;
  readonly sequence: number;
  readonly framework?: FrameworkIdentity;
  readonly capture?: CaptureDecision;
  readonly attributes?: Attributes;
  /**
   * Adopts a trace and span ID reserved before the turn started, such as one
   * already returned to a caller. Requires telemetry with stable `ids`.
   */
  readonly reference?: TraceReference;
  /**
   * Nests the turn under a caller's span in the caller's trace. A local
   * handoff sets this for the first turn; remote callees start their own trace.
   */
  readonly parent?: TraceReference;
  readonly links?: readonly TraceLink[];
  readonly startTimeMs?: number;
  /** Delegation lineage recorded by the host, when it is not carried by a handoff. */
  readonly lineage?: {
    readonly parentRunId?: string;
    readonly parentCallId?: string;
    readonly agentName?: string;
  };
  readonly channel?: { readonly kind?: string; readonly origin?: string };
  /** Host context for spans this process starts, such as OpenTelemetry baggage. */
  readonly context?: ExecutionContext;
}

export interface ResumeInput {
  readonly identity: RunIdentity;
  readonly context?: ExecutionContext;
}

interface MemoryInput<T> {
  identity: RunIdentity;
  storeId: string;
  slot: string;
  phase: string;
  capture?: CaptureDecision;
  /** Defaults to the active operation. */
  parent?: TraceReference;
  context?: ExecutionContext;
  describe?: (value: T) => {
    recordCount?: number;
    records?: readonly { id?: string; content: string }[];
  };
}

export interface AgentTracing {
  turn: import("./operations.js").WrappedOperation<TurnInput, TurnOperation>;
  /** Returns a saved durable turn, without starting one. */
  resume(input: ResumeInput): Promise<TurnOperation | undefined>;
  memory: AgentMemoryTracing;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}
export interface AgentMemoryTracing {
  search<T>(data: MemoryInput<T>, execute: () => T | PromiseLike<T>): Promise<T>;
  write<T>(data: MemoryInput<T>, execute: () => T | PromiseLike<T>): Promise<T>;
}

const METADATA_ONLY: CaptureDecision = { emit: true, recordInputs: false, recordOutputs: false };
const LIVE_TURNS = 1000;

interface LiveTurn {
  readonly root: LiveOperation;
  /** Token of the last checkpoint this process wrote. */
  revision: string | undefined;
  writes: number;
}

export function createAgentTracing(input: AgentTracingOptions): AgentTracing {
  const telemetry = input.telemetry ?? otelTelemetry();
  const checkpointer = input.checkpointer;
  if (checkpointer !== undefined && telemetry.ids === undefined)
    throw new Error(
      "Durable agent tracing needs stable span IDs. Pass the AgentSpanIdGenerator installed on your tracer provider to otelTelemetry({ idGenerator }).",
    );
  const report: TraceErrorHandler = (error, context) => {
    try {
      input.onError?.(error, context);
    } catch {}
  };
  const scopes = createScopes({
    telemetry,
    serializer: input.serializer ?? aiSdkContentSerializer,
    durable: checkpointer !== undefined,
    onError: input.onError,
  });
  // Turns hydrated in this process, so concurrent hooks share one tree. The
  // checkpoint stays authoritative: another process's write replaces the entry.
  const live = new Map<string, Promise<LiveTurn | undefined>>();

  function turnKey(identity: RunIdentity): string {
    if (checkpointer === undefined) return `turn:${randomUUID()}`;
    return ["turn", identity.runId, identity.turnId].map(encodeURIComponent).join(":");
  }

  /** Writes are serialized so a slow store never persists an older tree last. */
  function persistence(key: string, entry: () => LiveTurn | undefined) {
    let queue = Promise.resolve();
    return () => {
      const turn = entry();
      if (checkpointer === undefined || turn === undefined) return queue;
      turn.writes++;
      queue = queue.then(async () => {
        try {
          if (turn.root.settled) {
            live.delete(key);
            await checkpointer.delete(key);
          } else {
            const revision = randomUUID();
            await checkpointer.set(key, traceSnapshot({ ...turn.root.record(), revision }));
            turn.revision = revision;
          }
        } catch (error) {
          report(error, { phase: "checkpoint", operation: "activation" });
        } finally {
          turn.writes--;
        }
      });
      return queue;
    };
  }

  async function loadCheckpoint(key: string): Promise<unknown> {
    try {
      return await checkpointer!.get(key);
    } catch (error) {
      report(error, { phase: "restore", operation: "activation" });
      return undefined;
    }
  }

  async function hydrate(
    key: string,
    cached: LiveTurn | undefined,
    open: ((onChange: () => Promise<void>) => Promise<LiveOperation>) | undefined,
    context: ExecutionContext | undefined,
    capture?: CaptureDecision,
  ): Promise<LiveTurn | undefined> {
    const saved = checkpointer === undefined ? undefined : await loadCheckpoint(key);
    if (
      cached !== undefined &&
      (cached.writes > 0 || (saved as ScopeRecord | undefined)?.revision === cached.revision)
    ) {
      if (context !== undefined) cached.root.useContext(context);
      // A re-entry may decline content the cached turn was allowed to record.
      if (capture !== undefined) cached.root.narrow(capture);
      return cached;
    }
    let entry: LiveTurn | undefined;
    const onChange = persistence(key, () => entry);
    const restored =
      saved === undefined ? undefined : await scopes.restore(saved, { capture, context, onChange });
    const root = restored ?? (await open?.(onChange));
    if (root === undefined) return undefined;
    entry = { root, revision: (saved as ScopeRecord | undefined)?.revision, writes: 0 };
    if (restored === undefined) await onChange();
    return entry;
  }

  function cache(
    key: string,
    load: (cached: LiveTurn | undefined) => Promise<LiveTurn | undefined>,
  ): Promise<LiveTurn | undefined> {
    const previous = live.get(key);
    const loading = (async () =>
      load(previous === undefined ? undefined : await previous.catch(() => undefined)))();
    live.set(key, loading);
    void loading.then(
      (turn) => {
        if (turn === undefined || turn.root.settled) live.delete(key);
      },
      () => live.delete(key),
    );
    if (live.size > LIVE_TURNS) live.delete(live.keys().next().value!);
    return loading;
  }

  function startTurn(data: TurnInput, key: string) {
    return (onChange: () => Promise<void>) => {
      const handoff = currentAgentHandoff();
      const capture = intersectCapture(data.capture ?? METADATA_ONLY, handoff?.capture);
      const first = handoff !== undefined && data.sequence === 0;
      const parent =
        data.parent ?? (first && handoff?.remote !== true ? handoff?.caller : undefined);
      const caller =
        first && handoff?.remote === true
          ? [{ relationship: "agent.dispatch", context: handoff.caller }]
          : [];
      const links = [...caller, ...(data.links ?? [])];
      return scopes.start({
        identity: {
          ...data.identity,
          conversationId: handoff?.conversationId ?? data.identity.conversationId,
          agentName: data.agentName,
          framework: data.framework,
        },
        key,
        capture,
        parent,
        reference: telemetry.ids === undefined ? undefined : data.reference,
        startTimeMs: data.startTimeMs,
        data: {
          type: "activation",
          options: {
            sequence: data.sequence,
            attributes: data.attributes,
            channel: data.channel,
            subagent: handoff !== undefined || data.lineage !== undefined,
            subagentName: handoff?.agentName ?? data.lineage?.agentName,
            parentRunId: handoff?.parentRunId ?? data.lineage?.parentRunId,
            parentCallId: handoff?.parentCallId ?? data.lineage?.parentCallId,
          },
        },
        links: links.length === 0 ? undefined : links,
        context: data.context,
        onChange,
      });
    };
  }

  function handle(root: LiveOperation): TurnOperation {
    return operationHandle(
      root,
      { type: "activation", options: { sequence: 0 } },
      input.onError,
    ) as TurnOperation;
  }

  async function turnOperation(data: TurnInput): Promise<TurnOperation> {
    const key = turnKey(data.identity);
    const turn =
      checkpointer === undefined
        ? await hydrate(key, undefined, startTurn(data, key), data.context)
        : await cache(key, (cached) =>
            hydrate(key, cached, startTurn(data, key), data.context, data.capture),
          );
    return handle(turn!.root);
  }

  async function resume(data: ResumeInput): Promise<TurnOperation | undefined> {
    if (checkpointer === undefined) return undefined;
    const key = turnKey(data.identity);
    const turn = await cache(key, (cached) => hydrate(key, cached, undefined, data.context));
    return turn === undefined ? undefined : handle(turn.root);
  }

  async function lifecycle(callback: () => Promise<void>) {
    try {
      await callback();
    } catch (error) {
      report(error, { phase: "complete" });
    }
  }

  async function memory<T>(
    operation: "search_memory" | "upsert_memory",
    data: MemoryInput<T>,
    execute: () => T | PromiseLike<T>,
  ): Promise<T> {
    const active = telemetry.active();
    const handle = await scopes.start({
      identity: data.identity,
      key: `memory:${randomUUID()}`,
      capture: data.capture ?? active?.capture ?? METADATA_ONLY,
      parent: data.parent ?? active?.reference,
      context: data.context,
      data: {
        type: "memory",
        options: { operation, phase: data.phase, slot: data.slot, storeId: data.storeId },
      },
    });
    let value: T;
    try {
      value = await handle.run(execute);
    } catch (error) {
      await handle.fail(error).catch((tracingError) => report(tracingError, { phase: "complete" }));
      throw error;
    }
    await handle
      .complete({ outcome: "completed", ...data.describe?.(value) })
      .catch((error) => report(error, { phase: "complete" }));
    return value;
  }

  return {
    turn: wrappedOperation(turnOperation, undefined, input.onError),
    resume,
    memory: {
      search: (data, execute) => memory("search_memory", data, execute),
      write: (data, execute) => memory("upsert_memory", data, execute),
    },
    forceFlush: () => lifecycle(() => telemetry.forceFlush()),
    shutdown: () => lifecycle(() => telemetry.shutdown()),
  };
}
