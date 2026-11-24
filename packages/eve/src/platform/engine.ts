import type {
  InboxHook,
  SessionInboxPayload,
  SessionInboxTransport,
} from "#execution/session-inbox/inbox.js";
import { createHookConflictError } from "#execution/hook-ownership.js";
import {
  logicalSessionInboxToken,
  logicalSessionToken,
  sessionCommandHookToken,
} from "#execution/session-inbox/address.js";
import { runSession } from "#execution/session/run-session.js";
import type { SessionRecord } from "#execution/session/record.js";
import type { SessionRunResult } from "#execution/session/program.js";
import type { ToolStubHost } from "#execution/tool-stub-host.js";
import { HookNotFoundError } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import {
  decodeDeliveryAddress,
  delivered,
  hookAddress,
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
import { readSessionStreamTailIndex } from "#execution/session-event-stream.js";
import { sessionRuntime } from "#execution/session-runtime.js";
import { cancelsTurn, steeringDeliveryOf } from "#execution/session/active-turn.js";
import { SESSION_LIMITS } from "#execution/session/record.js";
import { resolveTurnPrincipal } from "#execution/session/principal.js";
import { SHARED_SESSION_STEPS } from "#execution/session/shared-steps.js";
import type {
  SessionStepCall,
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
export type { SessionHost, SessionRunResult } from "#execution/session/program.js";
export {
  runSession,
  type SessionRun,
  type SessionRunHost,
} from "#execution/session/run-session.js";

export interface SessionSteps {
  run<N extends SessionStepName>(
    name: N,
    input: SessionStepInput<N>,
    meta: StepMeta,
  ): Promise<SessionStepResult<N> | { readonly yielded: true }>;
  load<N extends SessionStepName>(
    result: SessionStepResult<N>,
    sessionId: string,
  ): Promise<SessionStepResult<N>>;
}

export interface SessionStepsOptions {
  readonly streams: SessionStreamSink;
  readonly interrupts?: SessionInterrupts;
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

export function sessionSteps(
  app: Pick<App, "durable" | "hosts">,
  options: SessionStepsOptions,
): SessionSteps {
  const host: SessionStepHost = {
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
          ? await runTurn(turn, input as TurnStepInput, meta, app, options)
          : await table[name](input);
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
  app: Pick<App, "hosts">,
  options: SessionStepsOptions,
): Promise<SessionStepResult<"turn"> | { readonly yielded: true }> {
  const stopped = { value: false };
  const stream = sinkStream(options.streams, app, meta.sessionId, stopped);
  const polled =
    meta.signals === undefined && options.interrupts?.poll !== undefined
      ? pollSignals(options.interrupts.poll.bind(options.interrupts), meta.sessionId, input)
      : undefined;
  const signals = meta.signals ?? polled?.signals;
  const work = turn(input, { ...meta, ...(signals !== undefined && { signals }) }, stream);
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
  app: Pick<App, "hosts">,
  sessionId: string,
  stopped: { readonly value: boolean },
): WritableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffered = "";
  let next: number | undefined;
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      if (stopped.value) return;
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      if (lines.length === 0) return;
      next ??= (await readSessionStreamTailIndex(app.hosts, sessionId)) + 1;
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
          apply(payloadOf(item));
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

function payloadOf(item: InboxItem): SessionInboxPayload {
  return item.body.kind === "deliver"
    ? (item.body.payload as SessionInboxPayload)
    : ({ kind: "cancel", deliveryId: item.id } as SessionInboxPayload);
}

export type ClaimResult =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly heldBy: string };

export interface SessionStore {
  begin(start: SessionStartInput & { readonly sessionId: string }): Promise<void>;
  claim(
    sessionId: string,
    addresses: readonly DeliveryAddress[],
    takeOver: boolean,
  ): Promise<ClaimResult>;
  sessionFor(address: DeliveryAddress): Promise<string | undefined>;
  enqueue(sessionId: string, item: Omit<InboxItem, "seq">): Promise<number>;
  itemsAfter(sessionId: string, seq: number, limit: number): Promise<readonly InboxItem[]>;
  saveRecord(sessionId: string, record: SessionRecord, throughSeq: number): Promise<void>;
  loadRun(sessionId: string): Promise<
    | {
        readonly start: SessionStartInput;
        readonly record?: SessionRecord;
        readonly throughSeq: number;
      }
    | undefined
  >;
  status(sessionId: string): Promise<SessionStatus | undefined>;
  setStatus(sessionId: string, status: SessionStatus): Promise<void>;
  readonly streams: SessionStreamSink & {
    read(sessionId: string, from: number): AsyncIterable<StreamLine>;
    tail(sessionId: string): Promise<number>;
  };
  readonly content: SessionContentStore;
}

export interface StoreRunHost {
  readonly step: SessionStepCall;
  readonly deploymentId: string;
  readonly toolStubs?: ToolStubHost;
}

export interface StoreDurable {
  readonly durable: Durable;
  readonly interrupts: SessionInterrupts;
  readonly streams: SessionStreamSink;
  readonly content: SessionContentStore;
  run(sessionId: string, host: StoreRunHost): Promise<SessionRunResult>;
}

const ITEMS_PAGE = 100;

export function storeDurable(options: {
  readonly store: SessionStore;
  wake(sessionId: string): Promise<void>;
}): StoreDurable {
  const { store, wake } = options;
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

  const inboxOf = (
    sessionId: string,
    from: number,
  ): SessionInboxTransport<InboxHook & { stop(): void }> & { yielded(): number } => {
    const command = sessionCommandHookToken(sessionId);
    const seqs = new WeakMap<object, number>();
    let next = from;
    return {
      yielded: () => next,
      open(token) {
        let stopped = false;
        let wakeHook: (() => void) | undefined;
        return {
          token,
          stop() {
            stopped = true;
            wakeHook?.();
          },
          async *[Symbol.asyncIterator](): AsyncGenerator<SessionInboxPayload> {
            while (!stopped) {
              const items =
                token === command ? await store.itemsAfter(sessionId, next, ITEMS_PAGE) : [];
              for (const item of items) {
                if (stopped) return;
                next = item.seq;
                const payload = structuredClone(payloadOf(item));
                seqs.set(payload, item.seq);
                for (const message of (payload as { messages?: object[] }).messages ?? [])
                  seqs.set(message, item.seq);
                yield payload;
              }
              if (items.length > 0) continue;
              await new Promise<void>((resolve) => {
                wakeHook = resolve;
                void nextArrival(sessionId).then(resolve);
              });
            }
          },
        };
      },
      async confirm(hook) {
        const claimed = await store.claim(
          sessionId,
          [canonicalAddress(hookAddress(hook.token))],
          false,
        );
        if (!claimed.claimed) throw createHookConflictError(hook.token, claimed.heldBy);
      },
      async dispose(hook) {
        hook.stop();
      },
      consumedThrough: from,
      isTakenOver: () => false,
      ownerRunId: () => sessionId,
      now: () => Date.now(),
      seqOf: (payload) => seqs.get(payload),
    };
  };

  const streamOf = (sessionId: string): WritableStream<Uint8Array> => {
    const decoder = new TextDecoder();
    let buffered = "";
    return new WritableStream<Uint8Array>({
      async write(chunk) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        if (lines.length > 0)
          await store.streams.append(sessionId, (await store.streams.tail(sessionId)) + 1, lines);
      },
      close: () => store.streams.close(sessionId),
    });
  };

  return {
    durable,
    interrupts: {
      poll: async (sessionId, afterSeq) => await store.itemsAfter(sessionId, afterSeq, ITEMS_PAGE),
    },
    streams: store.streams,
    content: store.content,
    async run(sessionId, host) {
      const loaded = await store.loadRun(sessionId);
      if (loaded === undefined) throw new Error(`Session "${sessionId}" isn't in the store.`);
      if ((await live(sessionId)) === undefined) return { kind: "ended", outcome: "completed" };
      await store.setStatus(sessionId, "running");
      const inbox = inboxOf(sessionId, loaded.throughSeq);
      const result = await runSession(
        {
          sessionId,
          start: loaded.start,
          ...(loaded.record !== undefined && { record: loaded.record }),
        },
        {
          all: (work) => Promise.allSettled(work) as never,
          now: () => Date.now(),
          next: (wakeOptions = {}) => nextOf(sessionId, inbox.yielded, wakeOptions),
          step: host.step,
          ...(host.toolStubs !== undefined && { toolStubs: host.toolStubs }),
          deploymentId: host.deploymentId,
          inbox,
          stream: streamOf(sessionId),
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
      return result;
    },
  };

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
          timer = setTimeout(() => resolve("due"), Math.max(0, until - Date.now()));
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

function canonicalAddress(to: DeliveryAddress): DeliveryAddress {
  const address = decodeDeliveryAddress(to);
  if (address.kind === "session") return hookAddress(logicalSessionToken(address.address));
  return hookAddress(logicalSessionInboxToken(address.token) ?? address.token);
}
