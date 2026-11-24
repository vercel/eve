import type { SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { assertRecordSessionCode } from "#execution/session/session-code.js";
import {
  canonicalAddress,
  inboxPayloadOf,
  sessionInbox,
  type ClaimResult,
} from "#execution/session-inbox/source.js";
import { runSession, type RunSessionHost } from "#execution/session/run-session.js";
import type { SessionRecord } from "#execution/session/record.js";
import type { SessionRunResult } from "#execution/session/program.js";
import { HookNotFoundError } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import {
  delivered,
  lineWritable,
  type DeliveryAddress,
  type Durable,
  type SessionStartInput,
  type SessionStatus,
  type StreamLine,
  type InboxItem,
  type SessionContentStore,
  type SessionInterrupts,
  type SessionStreamSink,
  type StepMeta,
  type StepSignals,
} from "#execution/durable.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import { sessionRuntime } from "#execution/session-runtime.js";
import { cancelsTurn, steeringDeliveryOf } from "#execution/session/active-turn.js";
import { SESSION_LIMITS } from "#execution/session/record.js";
import { resolveTurnPrincipal } from "#execution/session/principal.js";
import { SHARED_SESSION_STEPS } from "#execution/session/shared-steps.js";
import type {
  SessionStepInput,
  SessionStepName,
  SessionStepResult,
  SessionStepTable,
} from "#execution/session/steps.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import type { TurnStepInput } from "#execution/session/turn-step-types.js";
import {
  activeTurnId,
  isBetweenTurns,
  storedProjection,
  turnPosition,
} from "#harness/session-machine/view.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { App } from "#runtime/app.js";

export type {
  InboxItem,
  SessionContentStore,
  SessionInterrupts,
  SessionStreamSink,
  StepMeta,
  StepSignals,
} from "#execution/durable.js";
export type { SessionRecord } from "#execution/session/record.js";
export { SESSION_LIMITS, SessionRecordTooNew } from "#execution/session/record.js";
export type { ProgramHost, SessionRunResult } from "#execution/session/program.js";
export {
  runSession,
  type RunSessionHost,
  type SessionRun,
} from "#execution/session/run-session.js";

/** The session steps of eve, which an engine runs inside its own durable steps. */
export interface SessionSteps {
  /**
   * Runs one step. It returns `{ yielded: true }` when the step stops before `meta.deadline`, so
   * that the engine runs it again as a new attempt.
   */
  run<N extends SessionStepName>(
    name: N,
    input: SessionStepInput<N>,
    meta: StepMeta,
  ): Promise<SessionStepResult<N> | { readonly yielded: true }>;
  /** Loads the parts of a step result that the step kept out of line. */
  load<N extends SessionStepName>(
    result: SessionStepResult<N>,
    sessionId: string,
  ): Promise<SessionStepResult<N>>;
}

/** The options of {@link sessionSteps}. */
export interface SessionStepsOptions {
  /** Where the steps append the stream lines of sessions. */
  readonly streams: SessionStreamSink;
  /** Lets a running step read new input. */
  readonly interrupts?: SessionInterrupts;
  /** Where the steps keep large content out of line. */
  readonly content?: SessionContentStore;
}

const CONTENT_ID = "eve.content";
const OUT_OF_LINE_BYTES = SESSION_LIMITS.stepResultBytes / 16;
const STATE_DELTA_KEYS = ["history", "sessionState", "serializedContext"] as const;
const ENDS_SESSION: ReadonlySet<SessionStepName> = new Set([
  "closeSessionStream",
  "emitTerminalSessionCompletion",
  "emitTerminalSessionFailure",
]);

const POLL_INTERVAL_MS = 50;
const YIELD_MARGIN_MS = 1_000;
const YIELDED = Symbol("yielded");

/** Returns the session steps of eve for the app, which an engine calls from its durable steps. */
export function sessionSteps(app: App, options: SessionStepsOptions): SessionSteps {
  const host: SessionStepHost = {
    app,
    hosts: app.hosts,
    createRuntime: (config) => sessionRuntime(app.durable, app.hosts, config),
    setAttributes: async () => {},
    deliver: (to, payload) => delivered(app.durable.deliver(to, payload)),
  };
  const turn = turnStepOn(host);
  const table: SessionStepTable = {
    ...SHARED_SESSION_STEPS,
    dispatchRuns: async () => {
      throw new Error(
        "This engine runs no workflow tools, so a session step can't dispatch their runs.",
      );
    },
    applyRunMessages: async () => {
      throw new Error(
        "This engine runs no workflow tools, so a session step can't apply their messages.",
      );
    },
    turn: async () => {
      throw new Error("sessionSteps runs a turn through its stream sink.");
    },
  };
  const { content } = options;
  return {
    async run(name, input, meta) {
      const result =
        name === "turn"
          ? await runTurn(turn, input as TurnStepInput, meta, options)
          : await stepOf(table, name)(input);
      if (content === undefined || isYielded(result)) return result as never;
      const stored = await outOfLine(result, content, meta.sessionId);
      if (ENDS_SESSION.has(name)) await content.delete(meta.sessionId);
      return stored as never;
    },
    async load(result, sessionId) {
      return content === undefined ? result : await inline(result, content, sessionId);
    },
  };
}

function stepOf<N extends SessionStepName>(
  table: SessionStepTable,
  name: N,
): (input: SessionStepInput<N>) => Promise<SessionStepResult<N>> {
  return table[name] as (input: SessionStepInput<N>) => Promise<SessionStepResult<N>>;
}

function isYielded(result: unknown): result is { readonly yielded: true } {
  return typeof result === "object" && result !== null && "yielded" in result;
}

async function outOfLine<T>(
  result: T,
  content: SessionContentStore,
  sessionId: string,
): Promise<T> {
  const delta = (result as { readonly stateDelta?: Record<string, unknown> } | undefined)
    ?.stateDelta;
  if (delta === undefined) return result;
  const stored: Record<string, unknown> = { ...delta };
  for (const key of STATE_DELTA_KEYS) {
    if (delta[key] === undefined) continue;
    const bytes = new TextEncoder().encode(JSON.stringify(delta[key]));
    if (bytes.byteLength > OUT_OF_LINE_BYTES)
      stored[key] = { [CONTENT_ID]: await content.put(sessionId, bytes) };
  }
  return { ...result, stateDelta: stored };
}

async function inline<T>(result: T, content: SessionContentStore, sessionId: string): Promise<T> {
  const delta = (result as { readonly stateDelta?: Record<string, unknown> } | undefined)
    ?.stateDelta;
  if (delta === undefined) return result;
  const loaded: Record<string, unknown> = { ...delta };
  for (const key of STATE_DELTA_KEYS) {
    const id = (delta[key] as { readonly [CONTENT_ID]?: unknown } | undefined)?.[CONTENT_ID];
    if (typeof id !== "string") continue;
    loaded[key] = JSON.parse(new TextDecoder().decode(await content.get(sessionId, id)));
  }
  return { ...result, stateDelta: loaded };
}

async function runTurn(
  turn: ReturnType<typeof turnStepOn>,
  input: TurnStepInput,
  meta: StepMeta,
  options: SessionStepsOptions,
): Promise<SessionStepResult<"turn"> | { readonly yielded: true }> {
  const stopped = { value: false };
  const stream = sinkStream(options.streams, meta.sessionId, stopped);
  const polled =
    meta.signals === undefined && options.interrupts?.poll !== undefined
      ? pollSignals(options.interrupts.poll.bind(options.interrupts), meta.sessionId, input)
      : undefined;
  const signals = meta.signals ?? polled?.signals;
  const work = turn(
    { ...input, sessionWritable: stream },
    { ...meta, ...(signals !== undefined && { signals }) },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (meta.deadline === undefined) return await work;
    const margin = Math.min(YIELD_MARGIN_MS, Math.max(0, (meta.deadline - Date.now()) / 4));
    const yielding = new Promise<typeof YIELDED>((resolve) => {
      timer = setTimeout(() => resolve(YIELDED), Math.max(0, meta.deadline! - margin - Date.now()));
    });
    const settled = await Promise.race([work, yielding]);
    if (settled !== YIELDED) return settled;
    stopped.value = true;
    work.catch(() => {});
    return { yielded: true };
  } finally {
    clearTimeout(timer);
    polled?.stop();
  }
}

function sinkStream(
  streams: SessionStreamSink,
  sessionId: string,
  stopped: { readonly value: boolean },
): WritableStream<Uint8Array> {
  let next: number | undefined;
  return lineWritable({
    async write(lines) {
      if (stopped.value) return;
      next ??= (await streams.tail(sessionId)) + 1;
      await streams.append(sessionId, next, lines);
      next += lines.length;
    },
    async close() {
      if (!stopped.value) await streams.close(sessionId);
    },
  });
}

function pollSignals(
  poll: NonNullable<SessionInterrupts["poll"]>,
  sessionId: string,
  input: TurnStepInput,
): { readonly signals: StepSignals; stop(): void } {
  const cancel = new AbortController();
  const steer = new AbortController();
  const projection = storedProjection(readDurableSession(input.sessionState).state);
  const turn = {
    control: input.input?.control !== undefined,
    expectedTurnId: activeTurnId(turnPosition(projection)),
  };
  const identity = {
    callerCallId: input.caller?.callId,
    principal: resolveTurnPrincipal(
      isBetweenTurns(projection) ? input.input : undefined,
      input.serializedContext,
    ),
  };
  let stopped = false;
  const apply = (payload: SessionInboxPayload): void => {
    if (cancelsTurn(payload, turn)) cancel.abort(new TurnCancelledError());
    else if (
      !input.sessionState.hasProxyInputRequests &&
      steeringDeliveryOf(payload, identity) !== undefined
    )
      steer.abort();
  };
  void (async () => {
    let afterSeq: number | undefined;
    while (!stopped) {
      const items = await poll(sessionId, afterSeq ?? 0).catch(() => []);
      if (afterSeq === undefined) afterSeq = items.at(-1)?.seq ?? 0;
      else
        for (const item of items) {
          afterSeq = item.seq;
          apply(inboxPayloadOf(item));
        }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  })();
  return {
    signals: { cancel: cancel.signal, steer: steer.signal },
    stop() {
      stopped = true;
    },
  };
}

export type { ClaimResult } from "#execution/session-inbox/source.js";

/**
 * The storage of {@link storeDurable}: sessions, their addresses, inboxes, records, streams, and
 * content. Each operation is atomic.
 */
export interface SessionStore {
  /** Adds a new session with its start. */
  begin(start: SessionStartInput & { readonly sessionId: string }): Promise<void>;
  /** Claims addresses for a session. With `takeOver`, it takes them from another session. */
  claim(
    sessionId: string,
    addresses: readonly DeliveryAddress[],
    takeOver: boolean,
  ): Promise<ClaimResult>;
  /** Returns the session that owns an address. */
  sessionFor(address: DeliveryAddress): Promise<string | undefined>;
  /** Appends an item to the inbox of a session, and returns its `seq`. */
  enqueue(sessionId: string, item: Omit<InboxItem, "seq">): Promise<number>;
  /** Returns up to `limit` inbox items after `seq`. */
  itemsAfter(sessionId: string, seq: number, limit: number): Promise<readonly InboxItem[]>;
  /** Keeps a record, and the last inbox item that it consumed, in one write. */
  saveRecord(sessionId: string, record: SessionRecord, throughSeq: number): Promise<void>;
  /** Returns what a run of the session needs: its start, its last record, and its position. */
  loadRun(sessionId: string): Promise<
    | {
        readonly start: SessionStartInput;
        readonly record?: SessionRecord;
        readonly throughSeq: number;
      }
    | undefined
  >;
  /** Returns the status of a session. */
  status(sessionId: string): Promise<SessionStatus | undefined>;
  /** Sets the status of a session. */
  setStatus(sessionId: string, status: SessionStatus): Promise<void>;
  /** The streams of sessions, which eve also reads. */
  readonly streams: SessionStreamSink & {
    /** Reads the stream lines of a session from position `from`. */
    read(sessionId: string, from: number): AsyncIterable<StreamLine>;
  };
  /** The large content of sessions. */
  readonly content: SessionContentStore;
}

/** The parts of the run host that an engine gives to {@link StoreDurable.run}. */
export type StoreRunHost = Pick<RunSessionHost, "step" | "deploymentId" | "toolStubs">;

/** A durable engine over a {@link SessionStore}, from {@link storeDurable}. */
export interface StoreDurable {
  /** The operations that eve calls. Return it from `DurableEngine.start()`. */
  readonly durable: Durable;
  /** The interrupts for {@link sessionSteps}. */
  readonly interrupts: SessionInterrupts;
  /** The streams for {@link sessionSteps}. */
  readonly streams: SessionStreamSink;
  /** The content store for {@link sessionSteps}. */
  readonly content: SessionContentStore;
  /**
   * Runs a session from its last record, until it ends, parks, or moves. It throws
   * `SessionCodeMismatchError` and leaves the session parked when another session code wrote the
   * record.
   */
  run(sessionId: string, host: StoreRunHost): Promise<SessionRunResult>;
}

const ITEMS_PAGE = 100;

/** The options of a wake from {@link storeDurable}. */
export interface StoreWakeOptions {
  /**
   * The time, in milliseconds since the epoch, when the session must run again. Without it, run the
   * session now. The time can be far ahead, for example the 30-day session timeout.
   */
  readonly at?: number;
}

/**
 * Makes a durable engine from a store. The engine calls `wake` when a session must run: now, or at
 * the time `at`. Its own worker then calls {@link StoreDurable.run}. A wake can come while `run`
 * still runs the session. The engine can drop it: before `run` parks, it runs the session again
 * for input or a wake time that came during the run. `now` is the clock of the engine.
 */
export function storeDurable(options: {
  readonly store: SessionStore;
  wake(sessionId: string, options?: StoreWakeOptions): Promise<void>;
  now?(): number;
}): StoreDurable {
  const { store, wake } = options;
  const now = options.now ?? (() => Date.now());
  const arrivals = new Map<string, Set<() => void>>();
  const arrived = (sessionId: string): void => {
    for (const resolve of arrivals.get(sessionId) ?? []) resolve();
    arrivals.delete(sessionId);
  };
  const nextArrival = (sessionId: string): Promise<void> =>
    new Promise((resolve) => {
      let waiting = arrivals.get(sessionId);
      if (waiting === undefined) arrivals.set(sessionId, (waiting = new Set()));
      waiting.add(resolve);
    });
  const live = async (sessionId: string | undefined): Promise<string | undefined> => {
    if (sessionId === undefined) return undefined;
    const status = await store.status(sessionId);
    return status === undefined || status === "ended" || status === "failed"
      ? undefined
      : sessionId;
  };

  const durable: Durable = {
    async start(input) {
      const sessionId = input.sessionId ?? `session_${createUlid()}`;
      if ((await store.status(sessionId)) !== undefined) return { kind: "started", sessionId };
      await store.begin({ ...input, sessionId });
      const claimed = await store.claim(sessionId, input.addresses.map(canonicalAddress), false);
      if (!claimed.claimed) {
        await store.setStatus(sessionId, "ended");
        return { kind: "held" };
      }
      await wake(sessionId);
      return { kind: "started", sessionId };
    },
    async deliver(to, payload, deliverOptions) {
      const address = canonicalAddress(to);
      const sessionId = await live(await store.sessionFor(address));
      if (sessionId === undefined)
        return { accepted: false, reason: "inactive", cause: new HookNotFoundError(to.key) };
      await store.enqueue(sessionId, {
        body: { kind: "deliver", payload, to },
        id: deliverOptions?.key ?? `item_${createUlid()}`,
      });
      arrived(sessionId);
      await wake(sessionId);
      return { accepted: true, sessionId };
    },
    sessionFor: async (to) => await live(await store.sessionFor(canonicalAddress(to))),
    readStream: (sessionId, from) => store.streams.read(sessionId, from),
    tail: (sessionId) => store.streams.tail(sessionId),
    status: (sessionId) => store.status(sessionId),
  };

  return {
    durable,
    interrupts: {
      poll: async (sessionId, afterSeq) => await store.itemsAfter(sessionId, afterSeq, ITEMS_PAGE),
    },
    streams: store.streams,
    content: store.content,
    async run(sessionId, host) {
      while (true) {
        const { result, read } = await runOnce(sessionId, host);
        if (result.kind !== "parked") return result;
        const due = result.wakeAt !== undefined && result.wakeAt <= now();
        if (due || (await store.itemsAfter(sessionId, read, 1)).length > 0) continue;
        if (result.wakeAt !== undefined) await wake(sessionId, { at: result.wakeAt });
        return result;
      }
    },
  };

  async function runOnce(
    sessionId: string,
    host: StoreRunHost,
  ): Promise<{ readonly result: SessionRunResult; readonly read: number }> {
    const loaded = await store.loadRun(sessionId);
    if (loaded === undefined) throw new Error(`Session "${sessionId}" isn't in the store.`);
    if ((await live(sessionId)) === undefined)
      return { read: loaded.throughSeq, result: { kind: "ended", outcome: "completed" } };
    if (loaded.record !== undefined) assertRecordSessionCode(sessionId, loaded.record);
    await store.setStatus(sessionId, "running");
    const inbox = sessionInbox(
      sessionId,
      {
        itemsAfter: (seq, limit) => store.itemsAfter(sessionId, seq, limit),
        arrival: () => nextArrival(sessionId),
        claim: (address) => store.claim(sessionId, [address], false),
      },
      { throughSeq: loaded.throughSeq },
    );
    const result = await runSession(
      {
        sessionId,
        start: loaded.start,
        ...(loaded.record !== undefined && { record: loaded.record }),
      },
      {
        all: (work) => Promise.allSettled(work) as never,
        now,
        next: (wakeOptions = {}) => nextOf(sessionId, inbox.yielded, wakeOptions),
        step: host.step,
        ...(host.toolStubs !== undefined && { toolStubs: host.toolStubs }),
        deploymentId: host.deploymentId,
        inbox,
        stream: store.streams,
        async adopted(record, consumed) {
          await store.saveRecord(sessionId, record, consumed.throughSeq);
        },
      },
    );
    await store.setStatus(
      sessionId,
      result.kind === "parked"
        ? "parked"
        : result.kind === "ended" && result.outcome === "failed"
          ? "failed"
          : "ended",
    );
    return { read: inbox.yielded(), result };
  }

  async function nextOf(
    sessionId: string,
    yielded: () => number,
    wakeOptions: { readonly until?: number; readonly wake?: Promise<unknown> },
  ): Promise<"input" | "due" | "woken" | "park"> {
    const waits: Promise<"input" | "due" | "woken" | "park">[] = [
      nextArrival(sessionId).then(() => "input" as const),
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (wakeOptions.until !== undefined) {
      const until = wakeOptions.until;
      waits.push(
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("due"), Math.max(0, until - now()));
        }),
      );
    }
    if (wakeOptions.wake !== undefined) waits.push(wakeOptions.wake.then(() => "woken" as const));
    if (wakeOptions.until === undefined && wakeOptions.wake === undefined) {
      waits.push(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          const unread = await store.itemsAfter(sessionId, yielded(), 1);
          return unread.length > 0 ? ("input" as const) : ("park" as const);
        })(),
      );
    }
    try {
      return await Promise.race(waits);
    } finally {
      clearTimeout(timer);
    }
  }
}
