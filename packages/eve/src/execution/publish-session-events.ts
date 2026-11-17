import { isRetriedStep } from "#execution/hosts.js";
import { readSessionStreamTailIndex, streamSessionLines } from "#execution/session-event-stream.js";
import type { ControlDelivery } from "#harness/types.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapterContext } from "#channel/adapter.js";
import { type ContextContainer, contextStorage } from "#context/container.js";
import { runEffects, type RunEffectsInput } from "#definitions/kernel.js";
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
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession } from "#execution/session.js";
import {
  commitTransitions,
  joinCommits,
  saveTransition,
  sessionView,
  type Transition,
  dropClosedRecords,
} from "#harness/session-machine/commit.js";
import { announceWaiting } from "#harness/session-machine/waiting.js";
import { createLineCommitter } from "#harness/session-machine/lines.js";
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
import type {
  Commit,
  HandleEventFn,
  HarnessSession,
  HarnessSessionBase,
  SessionPublication,
} from "#harness/types.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { createLogger } from "#internal/logging.js";
import { eventsOfLine } from "#protocol/session-lines.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import type { FactPosition, StoredLine } from "#protocol/session-events/envelope.js";
import { FACT_CATALOG, isFactType } from "#protocol/session-events/catalog.js";
import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";
import type { Cause, ErrorInfo } from "#protocol/session-events/envelope.js";
import type { ControlSettlement } from "#harness/facts.js";
import { endSession } from "#harness/session-machine/deliveries.js";
import { SessionStreamWriteError } from "#harness/session-stream-write-error.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { sessionAgent } from "#definitions/agent.js";

const log = createLogger("execution.publish-session-events");

export type SessionEventOrigin = "own" | "relayed";

export interface SessionStepInput {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

export interface SessionHistoryStepInput extends SessionStepInput {
  readonly history: HarnessModelMessage[];
}

export type Entered<I extends object> = Omit<I, "rerun"> & {
  readonly rerun: boolean;
};

export type SessionStepState = Entered<SessionStepInput>;

export type SessionHistoryStepState = Entered<SessionHistoryStepInput>;

export function enterSessionStep<I extends object>(input: I): Entered<I> {
  return { ...input, rerun: isRetriedStep() };
}

export interface PublishedSessionEvents {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

export async function publishSessionEvents(
  target: SessionStepState,
  publications: readonly SessionPublication[],
  options?: { readonly canCancelTurn?: boolean },
): Promise<PublishedSessionEvents & { readonly cancelled: boolean }> {
  let cancelled = false;
  const published = await publishEventsFromStep(
    target,
    "own",
    joinCommits(publications),
    options?.canCancelTurn
      ? () => {
          cancelled = true;
        }
      : undefined,
  );
  return { ...published, cancelled };
}

async function publishEventsFromStep(
  target: SessionStepState,
  origin: SessionEventOrigin,
  publications: readonly SessionPublication[],
  cancelTurn?: () => void,
): Promise<PublishedSessionEvents> {
  const published = publications.filter((entry) => !Array.isArray(entry) || entry.length > 0);
  if (published.length === 0) {
    return { serializedContext: target.serializedContext, sessionState: target.sessionState };
  }
  const restored = await restoreSessionStep(target);
  return (
    await publishFromSessionStep(restored, {
      cancelTurn,
      origin,
      async publish(emit) {
        for (const publication of published) await emit(publication);
      },
    })
  ).published;
}

export interface RestoredSessionStep {
  readonly ctx: ContextContainer;
  readonly durableSession: DurableSession;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly rerun: boolean;
}

export interface RestoredSessionHistoryStep extends RestoredSessionStep {
  readonly history: HarnessModelMessage[];
}

export async function restoreSessionStep(step: SessionStepState): Promise<RestoredSessionStep> {
  return {
    ctx: await deserializeContext(step.serializedContext),
    durableSession: readDurableSession(step.sessionState),
    sessionWritable: step.sessionWritable,
    rerun: step.rerun,
  };
}

export interface SessionStepPublication<T, R, S extends HarnessSessionBase = HarnessSessionBase> {
  readonly cancelTurn?: () => void;
  readonly origin: SessionEventOrigin;
  readonly inputSource?: string;
  publish(emit: HandleEventFn, session: S): Promise<T>;
  updateSession?(session: S, published: T): SessionUpdate<R, S>;
}

export interface SessionUpdate<R, S extends HarnessSessionBase = HarnessSessionBase> {
  readonly session: S;
  readonly result?: R;
}

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

async function publishInSessionScope<T>(
  step: RestoredSessionStep & { readonly history?: HarnessModelMessage[] },
  publication: SessionStepPublication<T, unknown>,
): Promise<{ readonly result: T; readonly session: HarnessSessionBase }> {
  const { ctx } = step;
  enterSessionProjection(ctx, step.durableSession.state);
  const orphaned = await readOrphanedLines({
    rerun: step.rerun,
    sessionId: step.durableSession.sessionId,
    position: nextLinePosition(ctx),
    sessionWritable: step.sessionWritable,
  });
  const hydrated = hydrateDurableSession(step.durableSession);
  const session =
    step.history === undefined
      ? hydrated
      : { ...hydrated, history: validateHarnessModelMessages(step.history) };
  const instrumentation = bindSessionInstrumentation({
    agentName: sessionAgent(ctx).id,
    ctx,
    rootSessionId: session.rootSessionId ?? session.sessionId,
    sessionId: session.sessionId,
  });

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
        instrumentation?.createHandleEvent({
          handleEvent: publisher.publish,
          relayed: publication.origin === "relayed",
        }) ?? publisher.publish;
      const result = await publication.publish(emit, enrichedSession);
      await publisher.finish();
      return { result, session: enrichedSession };
    });
  } finally {
    await instrumentation?.flush();
    publisher.writer.release();
  }
}

export interface SessionEventWriter {
  close(): Promise<void>;
  release(): void;
}

export interface WrittenEvent {
  readonly event: SessionStreamEvent;
  readonly position: FactPosition;
  readonly progress: boolean;
  readonly view: SessionView;
}

interface StreamWriter extends SessionEventWriter {
  write(bytes: Uint8Array): Promise<void>;
}

export interface SessionEventDispatcher {
  readonly adapterCtx: ChannelAdapterContext;
  react(
    written: readonly WrittenEvent[],
    options?: Omit<RunEffectsInput, "written">,
  ): Promise<void>;
}

interface EventDispatcher extends SessionEventDispatcher {
  deliver(written: readonly WrittenEvent[]): Promise<void>;
}

export interface SessionEventPublisher {
  readonly dispatcher: SessionEventDispatcher;
  readonly writer: SessionEventWriter;
  emit(publication: SessionPublication): Promise<readonly WrittenEvent[]>;
  publish(publication: SessionPublication): Promise<void>;
  finish(options?: { readonly announce?: boolean }): Promise<void>;
}

export interface OrphanedLine {
  readonly line: StoredLine;
  readonly position: number;
}

const interruptedAttempts = new WeakMap<WritableStream<Uint8Array>, readonly OrphanedLine[]>();

export async function readOrphanedLines(input: {
  readonly sessionId: string;
  readonly position: number;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly rerun: boolean;
}): Promise<readonly OrphanedLine[]> {
  if (!input.rerun) return [];
  const { sessionId, sessionWritable, position: first } = input;
  let lines = interruptedAttempts.get(sessionWritable);
  if (lines === undefined) {
    lines = await readLinesFrom(sessionId, first);
    interruptedAttempts.set(sessionWritable, lines);
  }
  return lines.filter(({ position }) => position >= first);
}

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

export function foldOrphanedLines(
  projection: SessionProjection,
  lines: readonly OrphanedLine[],
): SessionProjection {
  let next = projection;
  for (const { line, position } of lines) {
    const events = "facts" in line ? eventsOfLine(line, position, line.at) : [];
    next = advance(next, line, position, events);
  }
  return next;
}

async function reconcilePublishedSessionLines(
  checkpoint: SessionProjection | undefined,
  sessionId: string,
): Promise<SessionProjection> {
  const projection = checkpoint ?? initialSessionProjection();
  return foldOrphanedLines(projection, await readLinesFrom(sessionId, projection.view.position));
}

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
  readonly orphaned?: readonly OrphanedLine[];
}): SessionEventPublisher {
  const { ctx } = input;
  const orphaned = [...(input.orphaned ?? [])];
  const dispatcher = createSessionEventDispatcher(input);
  const writer = openSessionEventWriter(input.sessionWritable);
  const committing = createLineCommitter();
  let before: SessionView | undefined;
  const emitOne = async (publication: SessionPublication): Promise<readonly WrittenEvent[]> => {
    const committer = await committing;
    if (before === undefined) before = copyView(currentView(ctx));
    const at = new Date().toISOString();
    const written: WrittenEvent[] = [];
    const lines = committer.commit(currentView(ctx), publication, nextLinePosition(ctx), at);
    for (const { line, bytes } of lines) {
      const position = nextLinePosition(ctx);
      const earlier = orphaned[0];
      if (earlier !== undefined) {
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
        committer.reset();
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
        options?.announce === false ? undefined : announceWaiting(before, currentView(ctx));
      before = undefined;
      if (announced !== undefined && announced.length > 0) await publish(announced);
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
  let reacting: Promise<void> = Promise.resolve();

  return {
    adapterCtx,
    async deliver(written) {
      if (written.length === 0) return;
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
      const reacted = reacting.then(() => runEffects(ctx, { ...options, written }));
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
      await streamWriter.write(bytes).catch((error: unknown) => {
        throw new SessionStreamWriteError(error);
      });
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

export function readSessionProjection(ctx: ContextContainer): SessionProjection {
  return currentProjection(ctx);
}

export interface SessionEnding {
  readonly outcome: "completed" | "failed";
  readonly settles?: readonly ControlSettlement[];
  readonly cause?: Cause;
  readonly control?: ControlDelivery;
  readonly error?: ErrorInfo;
}

export async function publishTerminalSessionEvent(input: {
  readonly errorId?: string;
  readonly ending: SessionEnding;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState?: DurableSessionState;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly turn?: { readonly id: string; readonly sequence: number };
  readonly turnId?: string;
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
    if (projection.view.session.status === "ended") {
      try {
        await openSessionEventWriter(input.sessionWritable).close();
      } catch {}
      return;
    }
    const ended = endSession(projection, input.ending);
    await writeUnroutedSessionEvent(input.sessionWritable, projection, ended).catch((writeError) =>
      log.error(`failed to write terminal ${type} event`, { ...fields, error: writeError }),
    );
    return;
  }

  if (projection.view.session.status === "ended") {
    try {
      await publisher.writer.close();
    } catch {
    } finally {
      publisher.writer.release();
    }
    return;
  }

  const auth = ctx.get(AuthKey) ?? null;
  ctx.setVirtualContext(SessionKey, {
    auth: { current: auth, initiator: ctx.get(InitiatorAuthKey) ?? auth },
    parent: ctx.get(ParentSessionKey),
    sessionId,
    turn: input.turn ?? { id: "turn_0", sequence: 0 },
  });

  const publish: HandleEventFn = async (event) => {
    await publisher.emit(event);
    await publisher.writer.close();
  };
  let instrumentation: ReturnType<typeof bindSessionInstrumentation>;
  try {
    instrumentation = bindSessionInstrumentation({
      agentName: sessionAgent(ctx).id,
      ctx,
      rootSessionId: ctx.get(ParentSessionKey)?.rootSessionId ?? sessionId,
      sessionId,
    });
  } catch (error) {
    log.error(`failed to bind instrumentation for terminal ${type} event`, { ...fields, error });
  }
  const emit = instrumentation?.createHandleEvent({ handleEvent: publish }) ?? publish;
  try {
    await contextStorage.run(ctx, () => emit(endSession(projection, input.ending)));
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
  projection: SessionProjection,
  commit: Commit,
): Promise<void> {
  const lines = (await createLineCommitter()).commit(
    projection.view,
    commit,
    projection.view.position,
  );
  const writer = openSessionEventWriter(sessionWritable);
  try {
    for (const { bytes } of lines) await writer.write(bytes);
    await writer.close();
  } finally {
    writer.release();
  }
}

export async function commitSessionStep(
  target: SessionStepState | RestoredSessionStep,
  decide: (view: MachineView) => readonly Transition[],
  options: {
    readonly origin: SessionEventOrigin;
    readonly cancelTurn?: () => void;
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
      const committed = commitTransitions(transitions);
      if (committed.length > 0) await emit(committed);
    },
    updateSession: (session) => ({
      session: transitions.reduce((next, transition) => saveTransition(next, transition), session),
    }),
  });
  return published;
}

function changesNothing(view: MachineView, transition: Transition): boolean {
  return (
    transition.turn === view.turn &&
    transition.events.length === 0 &&
    transition.signIns === undefined &&
    transition.relays === undefined &&
    transition.history === undefined
  );
}
