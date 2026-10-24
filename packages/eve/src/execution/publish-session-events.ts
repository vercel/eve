import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { readSessionStreamTailIndex, streamSessionLines } from "#execution/session-event-stream.js";
import type { ControlDelivery } from "#harness/types.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapterContext } from "#channel/adapter.js";
import { type ContextContainer, contextStorage } from "#context/container.js";
import { runReactions, type RunReactionsInput } from "#reactions/runner.js";
import { AuthKey, InitiatorAuthKey, ParentSessionKey, SessionKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import { forwardSessionInput } from "#execution/forward-session-input.js";
import {
  createDurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession } from "#execution/session.js";
import {
  saveTransition,
  sessionView,
  type Transition,
  dropClosedRecords,
} from "#harness/session-machine/commit.js";
import { announceWaiting } from "#harness/session-machine/waiting.js";
import { cascade } from "#harness/session-machine/cascade.js";
import { copyView } from "#protocol/session-projection/fold.js";
import {
  advance,
  currentProjection,
  currentView,
  enterSessionProjection,
  enterSessionProjectionAt,
  nextLinePosition,
  recordPublishedLine,
  saveSessionProjection,
} from "#harness/session-machine/current.js";
import {
  SESSION_PROJECTION_STATE_KEY,
  storedProjection,
  type SessionView as MachineView,
} from "#harness/session-machine/view.js";
import { validateHarnessModelMessages, type HarnessModelMessage } from "#harness/messages.js";
import { eventsOf } from "#harness/publication.js";
import type {
  HandleEventFn,
  HarnessSession,
  HarnessSessionBase,
  SessionPublication,
} from "#harness/types.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { createLogger } from "#internal/logging.js";
import { eventsOfLine, linesOf } from "#protocol/session-lines.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import {
  encodeLineBytes,
  type FactPosition,
  type StoredLine,
} from "#protocol/session-events/envelope.js";
import { FACT_CATALOG, isFactType } from "#protocol/session-events/catalog.js";
import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";
import type { Cause, ErrorInfo } from "#protocol/session-events/envelope.js";
import { sessionEndedFacts, type ControlSettlement } from "#harness/facts.js";
import { createStreamChecker, type StreamChecker } from "#protocol/session-events/checker.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.publish-session-events");

/**
 * Whose event a session publishes. Every event reaches the channel adapter, the
 * session stream, and stream-event hooks. The session's own events also reach
 * its instrumentation and carry its turn's delivery ids.
 *
 * A relayed event belongs to an exchange this session carries for a child
 * session or a workflow run: the question or sign-in it raised, the turn
 * boundary that question causes here, and the `interaction.settled` for the answer
 * this session routes back. This session's instrumentation never tracks that
 * pending input, so no event of the exchange reaches it; the child records its
 * side as its own.
 */
export type SessionEventOrigin = "own" | "relayed";

/** The session a step publishes to: its stream and the state it starts from. */
export interface SessionStepState {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

/** A {@link SessionStepState} with the conversation history, for a step that reads or changes it. */
export interface SessionHistoryStepState extends SessionStepState {
  readonly history: HarnessModelMessage[];
}

/** The context and session state a publication leaves behind. */
export interface PublishedSessionEvents {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Publishes a session step's own events, such as a workflow tool's
 * `call.progress`, exactly as a turn publishes its events. Call from a step
 * and adopt the result: hooks run in the session's context and may change it.
 */
export async function publishSessionEvents(
  target: SessionStepState,
  events: readonly SessionEvent[],
  options?: { readonly canCancelTurn?: boolean; readonly announce?: boolean },
): Promise<PublishedSessionEvents & { readonly cancelled: boolean }> {
  let cancelled = false;
  const published = await publishEventsFromStep(
    target,
    "own",
    events,
    options?.canCancelTurn
      ? () => {
          cancelled = true;
        }
      : undefined,
    options?.announce,
  );
  return { ...published, cancelled };
}

async function publishEventsFromStep(
  target: SessionStepState,
  origin: SessionEventOrigin,
  events: readonly SessionEvent[],
  cancelTurn?: () => void,
  announce?: boolean,
): Promise<PublishedSessionEvents> {
  if (events.length === 0) {
    return { serializedContext: target.serializedContext, sessionState: target.sessionState };
  }
  const restored = await restoreSessionStep(target);
  const { published } = await publishFromSessionStep(restored, {
    cancelTurn,
    announce,
    origin,
    async publish(emit) {
      await emit(events);
    },
  });
  return published;
}

/** A session step's context and session, restored so the step can publish. */
export interface RestoredSessionStep {
  readonly ctx: ContextContainer;
  readonly durableSession: DurableSession;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

/** A {@link RestoredSessionStep} with the history, so its publication sees a whole session. */
export interface RestoredSessionHistoryStep extends RestoredSessionStep {
  readonly history: HarnessModelMessage[];
}

export async function restoreSessionStep(step: SessionStepState): Promise<RestoredSessionStep> {
  return {
    ctx: await deserializeContext(step.serializedContext),
    durableSession: readDurableSession(step.sessionState),
    sessionWritable: step.sessionWritable,
  };
}

/**
 * What a session step publishes, and how it changes the session the
 * publication leaves. `S` is a {@link HarnessSession} only for a step
 * restored with its history.
 */
export interface SessionStepPublication<T, R, S extends HarnessSessionBase = HarnessSessionBase> {
  /** A hook stops this publication's running turn; its owner adopts the cancellation after commit. */
  readonly cancelTurn?: () => void;
  /** Admission-only steps record input without claiming the held turn made progress. */
  readonly announce?: boolean;
  readonly origin: SessionEventOrigin;
  /** Where a relayed input batch came from; the channel adapter and its forwarding see it. */
  readonly inputSource?: string;
  /** Emits the step's events in the session's context scope. */
  publish(emit: HandleEventFn, session: S): Promise<T>;
  /**
   * Changes the step makes to the session once the scope has committed it,
   * before its continuation token is reconciled.
   */
  updateSession?(session: S, published: T): SessionUpdate<R, S>;
}

/** The session a step keeps, and anything it derived while changing it. */
export interface SessionUpdate<R, S extends HarnessSessionBase = HarnessSessionBase> {
  readonly session: S;
  readonly result?: R;
}

/**
 * Publishes from a step that owns the session. Returns the context and session
 * state to adopt, and the result of `updateSession`. `step.ctx` is updated in place.
 * The history is published and returned only when the step was restored with it.
 */
export async function publishFromSessionStep<T, R = undefined>(
  step: RestoredSessionHistoryStep,
  publication: SessionStepPublication<T, R, HarnessSession>,
): Promise<{
  readonly published: PublishedSessionEvents & { readonly history: HarnessModelMessage[] };
  readonly result: R | undefined;
}>;
export async function publishFromSessionStep<T, R = undefined>(
  step: RestoredSessionStep,
  publication: SessionStepPublication<T, R>,
): Promise<{ readonly published: PublishedSessionEvents; readonly result: R | undefined }>;
export async function publishFromSessionStep<T, R>(
  step: RestoredSessionStep & { readonly history?: HarnessModelMessage[] },
  publication: SessionStepPublication<T, R>,
): Promise<{
  readonly published: PublishedSessionEvents & { readonly history?: HarnessModelMessage[] };
  readonly result: R | undefined;
}> {
  const { ctx } = step;
  const scoped = await publishInSessionScope(step, publication);
  const update: SessionUpdate<R> = publication.updateSession?.(scoped.session, scoped.result) ?? {
    session: scoped.session,
  };
  // The session saves the lifecycle it published, without the records whose owners it closed.
  const projection = readSessionProjection(ctx);
  const session = reconcileSessionContinuationToken(
    ctx,
    saveSessionProjection(dropClosedRecords(update.session, projection), ctx),
  );
  return {
    published: {
      serializedContext: serializeContext(ctx),
      sessionState: createDurableSessionState({ session }),
      ...("history" in session && { history: session.history as HarnessModelMessage[] }),
    },
    result: update.result,
  };
}

/**
 * Runs `publication.publish` in the session's context scope with an emit that
 * publishes each event in order. Returns its result and the session the scope
 * commits.
 */
async function publishInSessionScope<T>(
  step: RestoredSessionStep & { readonly history?: HarnessModelMessage[] },
  publication: SessionStepPublication<T, unknown>,
): Promise<{ readonly result: T; readonly session: HarnessSessionBase }> {
  const { ctx } = step;
  enterSessionProjection(ctx, step.durableSession.state);
  // The step decides from its checkpoint, so a retry writes again what its attempt wrote.
  const orphaned = await readOrphanedLines({
    sessionId: step.durableSession.sessionId,
    position: nextLinePosition(ctx),
    sessionWritable: step.sessionWritable,
  });
  const effectiveAgent = resolveEffectiveAgentRuntime(ctx.require(BundleKey), ctx);
  const hydrated = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
    durable: step.durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const session =
    step.history === undefined
      ? hydrated
      : { ...hydrated, history: validateHarnessModelMessages(step.history) };
  const instrumentation =
    publication.origin === "own"
      ? bindSessionInstrumentation({
          agentName: effectiveAgent.turnAgent.id,
          ctx,
          rootSessionId: session.rootSessionId ?? session.sessionId,
          sessionId: session.sessionId,
        })
      : undefined;

  const publisher = openSessionEventPublisher({
    cancelTurn: publication.cancelTurn,
    ctx,
    inputSource: publication.inputSource,
    orphaned,
    origin: publication.origin,
    sessionWritable: step.sessionWritable,
  });
  try {
    return await withContextScope(ctx, session, async (enrichedSession) => {
      const emit =
        instrumentation?.createHandleEvent({ handleEvent: publisher.publish }) ?? publisher.publish;
      const result = await publication.publish(emit, enrichedSession);
      await publisher.finish({ announce: publication.announce });
      return { result, session: enrichedSession };
    });
  } finally {
    await instrumentation?.flush();
    publisher.writer.release();
  }
}

/**
 * Holds a session's stream for one step, which keeps its writer lock until it
 * releases it. Events reach the stream through `SessionEventPublisher.emit`.
 */
export interface SessionEventWriter {
  /** Closes the session stream; only a terminal event (`done`, completion, or failure) does this. */
  close(): Promise<void>;
  /** Releases the writer lock so the next step can acquire it. Safe after `close()`. */
  release(): void;
}

/** One event as written: as readers read it back, with where it sits on the stream. */
export interface WrittenEvent {
  readonly event: SessionStreamEvent;
  readonly position: FactPosition;
  /** It rode as a progress record, which only hooks keyed on its type hear. */
  readonly progress: boolean;
  /** Immutable table snapshot after this record's whole line, not a later concurrent write. */
  readonly view: SessionView;
}

interface StreamWriter extends SessionEventWriter {
  /** Writes one line: one chunk, so a crash leaves all of it or none. */
  write(bytes: Uint8Array): Promise<void>;
}

/** Dispatches a session's written events to its channel and stream-event hooks. */
export interface SessionEventDispatcher {
  /** The context delivery hands the channel adapter; a turn step also hands it to `adapter.deliver`. */
  readonly adapterCtx: ChannelAdapterContext;
  /** Runs the session's reactions after written events; see `reactions/runner.ts`. */
  react(
    written: readonly WrittenEvent[],
    options?: Omit<RunReactionsInput, "written">,
  ): Promise<void>;
}

interface EventDispatcher extends SessionEventDispatcher {
  /**
   * After the write: relays each input request this session carries for its caller
   * (`forwardSessionInput`), or runs the channel adapter's handler, then saves the channel
   * context.
   */
  deliver(written: readonly WrittenEvent[]): Promise<void>;
}

/** A session's stream held by one step, with the dispatch of the events that step publishes. */
export interface SessionEventPublisher {
  readonly dispatcher: SessionEventDispatcher;
  readonly writer: SessionEventWriter;
  /**
   * Writes one publication (a commit's facts on one line, each progress record on its own),
   * folds each line into the step's projection, then runs the channel's handlers. Returns the
   * events as written, for their hooks.
   */
  emit(publication: SessionPublication): Promise<readonly WrittenEvent[]>;
  /** `emit`, then the events' stream-event hooks. */
  publish(publication: SessionPublication): Promise<void>;
  /**
   * Ends a unit of the step's progress: publishes what the tables now say about the open
   * turn waiting on people (`announceWaiting`). Steps call it as they end. A turn step passes
   * whether it stopped for a person; a step that runs while the turn waits leaves it to the
   * tables.
   */
  finish(options?: { readonly announce?: boolean }): Promise<void>;
}

/**
 * Whether publication checks each line against the event contract before writing it: on under
 * `eve dev` and with `EVE_CHECK_SESSION_EVENTS=1`, off with `EVE_CHECK_SESSION_EVENTS=0`. A
 * violation fails the publication instead of writing a line readers can't fold.
 */
export function checksSessionEvents(): boolean {
  const configured = process.env.EVE_CHECK_SESSION_EVENTS;
  if (configured === "1") return true;
  if (configured === "0") return false;
  return process.env.EVE_DEV === "1";
}

/** A line an interrupted attempt of the current step wrote after the step's checkpoint. */
export interface OrphanedLine {
  readonly line: StoredLine;
  readonly position: number;
}

/**
 * What an interrupted earlier attempt of the running step wrote, read once per attempt: the
 * attempt's own writes reach the stream only as it completes, so a later read could miss them.
 * Keyed by the attempt's session writable, which each attempt restores afresh.
 */
const interruptedAttempts = new WeakMap<WritableStream<Uint8Array>, readonly OrphanedLine[]>();

/**
 * The lines an interrupted earlier attempt of this step wrote after the checkpoint: none on a
 * first attempt, unless `always`, for a step that recovers what a failed step's attempts left.
 */
export async function readOrphanedLines(input: {
  readonly sessionId: string;
  readonly position: number;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly always?: boolean;
}): Promise<readonly OrphanedLine[]> {
  if (input.always !== true && !isRetriedStep()) return [];
  const { sessionId, sessionWritable, position: first } = input;
  let lines = interruptedAttempts.get(sessionWritable);
  if (lines === undefined) {
    lines = await readLinesFrom(sessionId, first);
    interruptedAttempts.set(sessionWritable, lines);
  }
  return lines.filter(({ position }) => position >= first);
}

/**
 * The state a retried step returns, following every line its interrupted attempt wrote. The
 * retry decides from the same checkpoint and writes the same lines again, so this changes
 * nothing; if its decisions changed and it wrote fewer, the lines it left still sit on the
 * stream, and the session folds them instead of writing its next lines over their positions.
 */
export function followInterruptedAttempt(
  sessionWritable: WritableStream<Uint8Array>,
  state: DurableSessionState,
): DurableSessionState {
  const session = readDurableSession(state);
  const projection = storedProjection(session.state);
  const unwritten = (interruptedAttempts.get(sessionWritable) ?? []).filter(
    ({ position }) => position >= projection.view.position,
  );
  if (unwritten.length === 0) return state;
  log.error(
    "a retried step wrote less than its interrupted attempt; the session follows the stream",
    {
      lines: unwritten.length,
      sessionId: state.sessionId,
    },
  );
  return replaceDurableSessionSnapshot({
    session: {
      ...session,
      state: {
        ...session.state,
        [SESSION_PROJECTION_STATE_KEY]: foldOrphanedLines(projection, unwritten),
      },
    },
    state,
  });
}

function isRetriedStep(): boolean {
  try {
    return getStepMetadata().attempt > 1;
  } catch (error) {
    if (error instanceof Error && error.name === "NotInStepContextError") return false;
    throw error;
  }
}

async function readLinesFrom(sessionId: string, first: number): Promise<OrphanedLine[]> {
  const tail = await readSessionStreamTailIndex(sessionId);
  if (tail + 1 < first) throw new Error("Session checkpoint is ahead of its stream.");
  const lines: OrphanedLine[] = [];
  if (tail < first) return lines;
  let position = first;
  for await (const record of streamSessionLines(sessionId, { follow: false, startIndex: first })) {
    if (record.position > tail) break;
    if (record.line === undefined || record.position !== position) {
      throw new Error("Cannot reconcile an unreadable or missing session line.");
    }
    lines.push({ line: record.line, position: position++ });
  }
  if (position !== tail + 1) throw new Error("Session stream ended before its reported tail.");
  return lines;
}

/** The projection with orphaned lines folded in, as if the step had just written them. */
export function foldOrphanedLines(
  projection: SessionProjection,
  lines: readonly OrphanedLine[],
): SessionProjection {
  let next = projection;
  for (const { line, position } of lines) {
    // Progress advances the physical cursor but changes no durable lifecycle table.
    const events = "facts" in line ? eventsOfLine(line, position, line.at) : [];
    next = advance(next, line, position, events);
  }
  return next;
}

/** Folds the physical tail for terminal closure, without guessing auth or replaying authored work. */
async function reconcilePublishedSessionLines(
  checkpoint: SessionProjection | undefined,
  sessionId: string,
): Promise<SessionProjection> {
  const projection = checkpoint ?? initialSessionProjection();
  return foldOrphanedLines(projection, await readLinesFrom(sessionId, projection.view.position));
}

/**
 * Whether a line a retry would write is the one its interrupted attempt wrote there: the same
 * facts, by type and entity, or the same progress record. Timestamps and incidental ids differ.
 */
function sameLine(orphaned: StoredLine, line: StoredLine<SessionEvent, SessionEvent>): boolean {
  if ("progress" in line || "progress" in orphaned) {
    return (
      "progress" in line &&
      "progress" in orphaned &&
      JSON.stringify(orphaned.progress) === JSON.stringify(line.progress)
    );
  }
  const identity = (fact: unknown) => {
    const { data, type } = fact as SessionEvent;
    if (!isFactType(type)) return String(type);
    const id = (data as Readonly<Record<string, unknown>>)[FACT_CATALOG[type].idField];
    return `${type}:${String(id)}`;
  };
  return (
    orphaned.facts.length === line.facts.length &&
    orphaned.facts.every((fact, index) => identity(fact) === identity(line.facts[index]))
  );
}

export function openSessionEventPublisher(input: {
  readonly cancelTurn?: () => void;
  readonly ctx: ContextContainer;
  readonly origin: SessionEventOrigin;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly inputSource?: string;
  /**
   * What an interrupted attempt of this step already wrote. Each line the publication would
   * write again is folded from the stream instead, and its handlers and hooks don't run again.
   */
  readonly orphaned?: readonly OrphanedLine[];
}): SessionEventPublisher {
  const { ctx } = input;
  const orphaned = [...(input.orphaned ?? [])];
  const dispatcher = createSessionEventDispatcher(input);
  // Opened after the dispatcher, so a context that cannot build one leaves the
  // stream unlocked for the terminal event's fallback write.
  const writer = openSessionEventWriter(input.sessionWritable);
  let checker: StreamChecker | undefined;
  // The tables as the step's first publication found them, for what its end announces.
  let before: SessionView | undefined;
  const emitOne = async (publication: SessionPublication): Promise<readonly WrittenEvent[]> => {
    if (checker === undefined && checksSessionEvents()) {
      const { schemaViolation } = await import("#protocol/session-events/schemas.js");
      checker = createStreamChecker({
        seed: currentProjection(ctx).view,
        validate: schemaViolation,
      });
    }
    if (before === undefined) before = copyView(currentView(ctx));
    const events = cascade(currentView(ctx), eventsOf(publication));
    const at = new Date().toISOString();
    const written: WrittenEvent[] = [];
    // Preflight every line before the first write: an oversize progress record must not leave
    // an earlier part of the publication durably written.
    const lines = linesOf(events, at).map((line) => ({ line, bytes: encodeLineBytes(line) }));
    lines.forEach(({ line }, index) => {
      const violations = checker?.check(line, nextLinePosition(ctx) + index);
      if (violations !== undefined && violations.length > 0) {
        checker = undefined;
        throw new Error(
          `Session event contract: ${violations
            .map(
              (violation) =>
                `${violation.rule} at ${violation.position}:${violation.index ?? "progress"}: ${violation.message}`,
            )
            .join("; ")}`,
        );
      }
    });
    for (const { line, bytes } of lines) {
      const position = nextLinePosition(ctx);
      const earlier = orphaned[0];
      if (earlier !== undefined) {
        // Only a decision the retry repeats exactly can adopt what its attempt wrote.
        if (earlier.position !== position || !sameLine(earlier.line, line)) {
          throw new Error("A retried step published differently from its interrupted attempt.");
        }
        orphaned.shift();
        const lineAt = "facts" in earlier.line ? earlier.line.at : at;
        recordPublishedLine(
          ctx,
          earlier.line,
          position,
          eventsOfLine(earlier.line, position, lineAt),
        );
        continue;
      }
      await writer.write(bytes).catch((error: unknown) => {
        // Validation ran ahead of the write. A failed write must not leave the checker ahead
        // of the checkpoint; a later publication reseeds it from what actually committed.
        checker = undefined;
        throw error;
      });
      const lineEvents = eventsOfLine(line, position, at);
      recordPublishedLine(ctx, line, position, lineEvents);
      const progress = "progress" in line;
      const view = currentView(ctx);
      lineEvents.forEach((event) =>
        written.push({ event, position: event.meta.position, progress, view }),
      );
    }
    await dispatcher.deliver(written);
    return written;
  };
  // Local calls execute concurrently. Serialize publication through write, fold and channel
  // delivery so two calls cannot reserve the same position or overwrite channel state. A
  // failure rejects its caller but releases this lane for terminal cleanup.
  let publicationTail: Promise<unknown> = Promise.resolve();
  const emit = (publication: SessionPublication): Promise<readonly WrittenEvent[]> => {
    const next = publicationTail.then(() => emitOne(publication));
    publicationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const publish = async (publication: SessionPublication): Promise<void> => {
    const cancelTurn = input.cancelTurn;
    await dispatcher.react(
      await emit(publication),
      cancelTurn === undefined ? undefined : { cancelTurn: () => cancelTurn() },
    );
  };
  return {
    dispatcher,
    writer,
    emit,
    publish,
    async finish(options) {
      if (before === undefined) return;
      const announced =
        options?.announce === false ? [] : announceWaiting(before, currentView(ctx));
      before = undefined;
      if (announced.length > 0) await publish(announced);
    },
  };
}

function createSessionEventDispatcher(input: {
  readonly ctx: ContextContainer;
  readonly inputSource?: string;
}): EventDispatcher {
  const { ctx, inputSource } = input;
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const deliveryCtx = inputSource === undefined ? adapterCtx : { ...adapterCtx, inputSource };
  // Commits react one at a time, in order. Inline tool calls publish concurrently, and a slow
  // reaction to an earlier commit must not write its slot over a later commit's.
  let reacting: Promise<void> = Promise.resolve();

  return {
    adapterCtx,
    async deliver(written) {
      if (written.length === 0) return;
      // Each committed line's facts, for its `committed` handler once the line's events ran.
      let line: { facts: SessionEvent[]; position: FactPosition; view: SessionView } | undefined;
      const committed = async () => {
        if (line === undefined) return;
        const { facts, position, view } = line;
        line = undefined;
        await callAdapterEventHandler(
          adapter,
          { facts, position: position.line },
          { ...deliveryCtx, position, scope: undefined, view },
        );
      };
      for (const { event, position, progress, view } of written) {
        if (line !== undefined && line.position.line !== position.line) await committed();
        if (await forwardSessionInput(ctx, event, inputSource)) continue;
        if (!progress) (line ??= { facts: [], position, view }).facts.push(event);
        const scope = "scope" in event ? event.scope : undefined;
        await callAdapterEventHandler(adapter, event, { ...deliveryCtx, position, scope, view });
      }
      await committed();
      setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
    },
    react(written, options) {
      if (written.length === 0) return Promise.resolve();
      const reacted = reacting.then(() => runReactions(ctx, { ...options, written }));
      reacting = reacted.catch(() => undefined);
      return reacted;
    },
  };
}

function openSessionEventWriter(sessionWritable: WritableStream<Uint8Array>): StreamWriter {
  const streamWriter = sessionWritable.getWriter();

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    streamWriter.releaseLock();
  };
  return {
    async write(bytes) {
      await streamWriter.write(bytes);
    },
    close: async () => {
      try {
        await streamWriter.close();
      } finally {
        release();
      }
    },
    release,
  };
}

/** The session's projection as of the last event it published. */
export function readSessionProjection(ctx: ContextContainer): SessionProjection {
  return currentProjection(ctx);
}

/** How a session ends from outside a turn. */
export interface SessionEnding {
  readonly outcome: "completed" | "failed";
  readonly settles?: readonly ControlSettlement[];
  readonly cause?: Cause;
  /** The reset control that ends the session, when it named its delivery. */
  readonly control?: ControlDelivery;
  readonly error?: ErrorInfo;
}

/**
 * Ends the session from outside a turn: one commit settles what it left open and ends it
 * (`session.ended`), through its channel adapter and instrumentation, then closes the session
 * stream so readers following it reach its end. Stream-event hooks do not run: the ending session
 * may not restore, and no turn scope remains for authored code. Throws only when the session's
 * published tail cannot be read, which the ending must follow.
 *
 * When the context cannot be restored, the commit is only written and the stream closed: the one
 * degraded write of a session event.
 */
export async function publishTerminalSessionEvent(input: {
  readonly errorId?: string;
  readonly ending: SessionEnding;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState?: DurableSessionState;
  readonly sessionWritable: WritableStream<Uint8Array>;
  /** The session's last turn, for channel handlers' `ctx.session.turn`. */
  readonly turn?: { readonly id: string; readonly sequence: number };
  /** The turn the event ends, for instrumentation. */
  readonly turnId?: string;
  /** The session's last checkpointed projection: what's open, and the next line's position. */
  readonly projection?: SessionProjection;
}): Promise<void> {
  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  const fields = { errorId: input.errorId, sessionId };
  const type = "session.ended";
  let projection =
    input.projection ??
    (input.sessionState === undefined
      ? undefined
      : storedProjection(readDurableSession(input.sessionState).state));
  try {
    projection = await reconcilePublishedSessionLines(projection, sessionId);
  } catch (error) {
    // Ending over the checkpoint alone could miss rows the tail opened and close rows it closed,
    // so the step retries instead.
    log.error(`failed to fold the published tail for terminal ${type} event`, {
      ...fields,
      error,
    });
    throw error;
  }
  let ctx: ContextContainer;
  let publisher: SessionEventPublisher;
  try {
    ctx = await deserializeContext(input.serializedContext);
    enterSessionProjectionAt(ctx, projection);
    publisher = openSessionEventPublisher({
      ctx,
      origin: "own",
      sessionWritable: input.sessionWritable,
    });
  } catch (error) {
    log.error(`failed to restore context for terminal ${type} event`, { ...fields, error });
    // Folding needs no provider or authority; a broken context must not hide orphaned facts.
    if (projection.view.session.status === "ended") {
      try {
        await openSessionEventWriter(input.sessionWritable).close();
      } catch {
        // Another attempt may have closed the stream already.
      }
      return;
    }
    const closed = cascade(projection.view, sessionEndedFacts(projection, input.ending));
    await writeUnroutedSessionEvent(input.sessionWritable, closed).catch((writeError) =>
      log.error(`failed to write terminal ${type} event`, { ...fields, error: writeError }),
    );
    return;
  }

  if (projection.view.session.status === "ended") {
    try {
      await publisher.writer.close();
    } catch {
      // The terminal fact survived an earlier attempt that already closed the stream.
    } finally {
      publisher.writer.release();
    }
    return;
  }

  // Terminal events publish outside any turn step, and only a turn step
  // installs the session callback context that channel `session.ended`
  // handlers read, so install it here. A prewarmed session that expires,
  // resets, or closes before its first message has no turn yet: `turn_0`.
  const auth = ctx.get(AuthKey) ?? null;
  ctx.setVirtualContext(SessionKey, {
    auth: { current: auth, initiator: ctx.get(InitiatorAuthKey) ?? auth },
    parent: ctx.get(ParentSessionKey),
    sessionId,
    turn: input.turn ?? { id: "turn_0", sequence: 0 },
  });

  // Emitted without its hooks; see above.
  const publish: HandleEventFn = async (event) => {
    await publisher.emit(event);
    await publisher.writer.close();
  };
  let instrumentation: ReturnType<typeof bindSessionInstrumentation>;
  try {
    instrumentation = bindSessionInstrumentation({
      agentName: ctx.require(BundleKey).turnAgent.id,
      ctx,
      rootSessionId: ctx.get(ParentSessionKey)?.rootSessionId ?? sessionId,
      sessionId,
    });
  } catch (error) {
    log.error(`failed to bind instrumentation for terminal ${type} event`, { ...fields, error });
  }
  const emit = instrumentation?.createHandleEvent({ handleEvent: publish }) ?? publish;
  try {
    await contextStorage.run(ctx, () => emit(sessionEndedFacts(projection, input.ending)));
  } catch (error) {
    log.error(`failed to publish terminal ${type} event`, { ...fields, error });
  } finally {
    publisher.writer.release();
    try {
      await instrumentation?.flush();
    } catch (error) {
      log.error(`failed to flush instrumentation after terminal ${type} event`, {
        ...fields,
        error,
      });
    }
  }
}

async function writeUnroutedSessionEvent(
  sessionWritable: WritableStream<Uint8Array>,
  facts: readonly SessionEvent[],
): Promise<void> {
  const writer = openSessionEventWriter(sessionWritable);
  try {
    const lines = linesOf(facts, new Date().toISOString()).map(encodeLineBytes);
    for (const bytes of lines) await writer.write(bytes);
    await writer.close();
  } finally {
    writer.release();
  }
}

/**
 * The commit of a step that owns the session outside a turn: restore it, decide its transitions
 * against what it restored, publish their events in order, and save what they change.
 * Used by relay-changing steps outside a turn; other steps still publish or apply transitions
 * directly. Batches keep the turn unchanged and contain at most one sign-in snapshot.
 */
export async function commitSessionStep(
  target: SessionStepState | RestoredSessionStep,
  decide: (view: MachineView) => readonly Transition[],
  options: {
    readonly origin: SessionEventOrigin;
    readonly cancelTurn?: () => void;
    /** Where a relayed input batch came from; see `SessionStepPublication.inputSource`. */
    readonly inputSource?: string;
  },
): Promise<PublishedSessionEvents> {
  const { state } =
    "ctx" in target ? target.durableSession : readDurableSession(target.sessionState);
  const view = sessionView(storedProjection(state), state);
  const transitions = decide(view);
  if (
    (transitions.length > 1 && transitions.some((transition) => transition.turn !== view.turn)) ||
    transitions.filter((transition) => transition.signIns !== undefined).length > 1
  ) {
    throw new Error("A transition batch must not overlap turn or sign-in snapshots.");
  }
  // The batch is one commit: the publisher closes what its owners' ends leave open, seeing it whole.
  if ("ctx" in target) return await commit(target, transitions, options);
  if (transitions.every((transition) => changesNothing(view, transition))) {
    return { serializedContext: target.serializedContext, sessionState: target.sessionState };
  }
  return await commit(await restoreSessionStep(target), transitions, options);
}

async function commit(
  restored: RestoredSessionStep,
  transitions: readonly Transition[],
  options: {
    readonly origin: SessionEventOrigin;
    readonly inputSource?: string;
    readonly cancelTurn?: () => void;
  },
): Promise<PublishedSessionEvents> {
  const { published } = await publishFromSessionStep(restored, {
    inputSource: options.inputSource,
    cancelTurn: options.cancelTurn,
    origin: options.origin,
    async publish(emit) {
      // One commit: the batch's events are one atomic line.
      const events = transitions.flatMap((transition) => transition.events);
      if (events.length > 0) await emit(events);
    },
    // Save onto the session the scope committed, which carries what its providers captured.
    updateSession: (session) => ({
      session: transitions.reduce((next, transition) => saveTransition(next, transition), session),
    }),
  });
  return published;
}

/** A transition that reports nothing and changes no record, as the machine decides with no work. */
function changesNothing(view: MachineView, transition: Transition): boolean {
  return (
    transition.turn === view.turn &&
    transition.events.length === 0 &&
    transition.signIns === undefined &&
    transition.relays === undefined &&
    transition.commit === undefined &&
    transition.clearsHistory === undefined
  );
}
