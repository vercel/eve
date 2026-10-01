import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapterContext } from "#channel/adapter.js";
import { type ContextContainer, contextStorage } from "#context/container.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { ParentSessionKey, TurnDeliveryIdsKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import { forwardSessionActivity } from "#execution/forward-session-activity.js";
import { forwardSessionInput } from "#execution/forward-session-input.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession } from "#execution/session.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { validateHarnessModelMessages, type HarnessModelMessage } from "#harness/messages.js";
import type { HandleEventFn, HarnessSession, HarnessSessionBase } from "#harness/types.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { createLogger } from "#internal/logging.js";
import {
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.publish-session-events");

/**
 * Whose event a session publishes. Every event reaches the channel adapter, the
 * session stream, and stream-event hooks. The session's own events also reach
 * its instrumentation and carry its turn's delivery ids.
 *
 * A relayed event belongs to an exchange this session carries for a child
 * session or a workflow run: the question or sign-in it raised, the turn
 * boundary that question causes here, and the `input.resolved` for the answer
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
 * `action.partial`, exactly as a turn publishes its events. Call from a step
 * and adopt the result: hooks run in the session's context and may change it.
 */
export async function publishSessionEvents(
  target: SessionStepState,
  events: readonly UnstampedMessageStreamEvent[],
): Promise<PublishedSessionEvents> {
  return await publishEventsFromStep(target, "own", events);
}

/** Publishes events of an exchange this session relays; see {@link SessionEventOrigin}. */
export async function relaySessionEvents(
  target: SessionStepState,
  events: readonly UnstampedMessageStreamEvent[],
): Promise<PublishedSessionEvents> {
  return await publishEventsFromStep(target, "relayed", events);
}

async function publishEventsFromStep(
  target: SessionStepState,
  origin: SessionEventOrigin,
  events: readonly UnstampedMessageStreamEvent[],
): Promise<PublishedSessionEvents> {
  if (events.length === 0) {
    return { serializedContext: target.serializedContext, sessionState: target.sessionState };
  }
  const { published } = await publishFromSessionStep(await restoreSessionStep(target), {
    origin,
    async publish(emit) {
      for (const event of events) await emit(event);
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
  const session = reconcileSessionContinuationToken(ctx, update.session);
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
    ctx,
    inputSource: publication.inputSource,
    origin: publication.origin,
    sessionWritable: step.sessionWritable,
  });
  try {
    return await withContextScope(ctx, session, async (enrichedSession) => {
      const emit =
        instrumentation?.createHandleEvent({
          handleEvent: publisher.publish,
          turnId: activeTurnId(getHarnessEmissionState(step.durableSession.state)),
        }) ?? publisher.publish;
      return { result: await publication.publish(emit, enrichedSession), session: enrichedSession };
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
  /** Closes the session stream; only a terminal `done` step does this. */
  close(): Promise<void>;
  /** Releases the writer lock so the next step can acquire it. Safe after `close()`. */
  release(): void;
}

interface StreamWriter extends SessionEventWriter {
  /** Stamps the event, then writes it; returns the event as written. */
  write(event: UnstampedMessageStreamEvent): Promise<MessageStreamEvent>;
}

/** Dispatches a session's events to its channel and stream-event hooks. */
export interface SessionEventDispatcher {
  /** The context delivery hands the channel adapter; a turn step also hands it to `adapter.deliver`. */
  readonly adapterCtx: ChannelAdapterContext;
  /**
   * Runs the stream-event hooks for a written event. Only a turn step passes
   * `cancelTurn`; see `turn-event-handler.ts`.
   */
  runHooks(event: MessageStreamEvent, cancelTurn?: () => void): Promise<void>;
}

interface EventDispatcher extends SessionEventDispatcher {
  /**
   * Channel delivery: `forwardSessionInput` or the channel adapter's handler,
   * then the channel context, then a delegated session's activity report.
   * Returns the event as the handler left it.
   */
  deliver(event: UnstampedMessageStreamEvent): Promise<UnstampedMessageStreamEvent>;
}

/** A session's stream held by one step, with the dispatch of the events that step publishes. */
export interface SessionEventPublisher {
  readonly dispatcher: SessionEventDispatcher;
  readonly writer: SessionEventWriter;
  /**
   * Delivers and writes one event the step produced, and returns it
   * as written for its hooks. Delivery comes first so the channel adapter's
   * handler shapes what is written.
   */
  emit(event: UnstampedMessageStreamEvent): Promise<MessageStreamEvent>;
  /** `emit`, then the event's stream-event hooks. */
  publish(event: UnstampedMessageStreamEvent): Promise<void>;
}

export function openSessionEventPublisher(input: {
  readonly ctx: ContextContainer;
  readonly origin: SessionEventOrigin;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly inputSource?: string;
}): SessionEventPublisher {
  const { ctx, origin } = input;
  const dispatcher = createSessionEventDispatcher(input);
  // Opened after the dispatcher, so a context that cannot build one leaves the
  // stream unlocked for the terminal event's fallback write.
  const writer = openSessionEventWriter({
    deliveryIds: () => (origin === "own" ? ctx.get(TurnDeliveryIdsKey) : undefined),
    sessionWritable: input.sessionWritable,
  });
  const emit = async (event: UnstampedMessageStreamEvent): Promise<MessageStreamEvent> => {
    return await writer.write(await dispatcher.deliver(event));
  };
  return {
    dispatcher,
    writer,
    emit,
    async publish(event) {
      await dispatcher.runHooks(await emit(event));
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

  return {
    adapterCtx,
    async deliver(event) {
      const forwarded = await forwardSessionInput(ctx, event, inputSource);
      const routed = forwarded
        ? event
        : await callAdapterEventHandler(
            adapter,
            event,
            inputSource === undefined ? adapterCtx : { ...adapterCtx, inputSource },
          );
      setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
      await forwardSessionActivity(ctx, routed);
      return routed;
    },
    async runHooks(event, cancelTurn) {
      // Read here rather than when the dispatcher is built: terminal delivery
      // runs no hooks and must not require the bundle.
      await dispatchStreamEventHooks({
        cancelTurn,
        ctx,
        event,
        registry: ctx.require(BundleKey).hookRegistry,
      });
    },
  };
}

function openSessionEventWriter(input: {
  /**
   * The delivery ids stamped on each event. Read at each write because a turn
   * step records its delivery ids after it opens the stream.
   */
  readonly deliveryIds: () => readonly string[] | undefined;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): StreamWriter {
  const streamWriter = input.sessionWritable.getWriter();

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    streamWriter.releaseLock();
  };
  return {
    async write(event) {
      const stamped = stampMessageStreamEvent(event, input.deliveryIds());
      await streamWriter.write(encodeMessageStreamEvent(stamped));
      return stamped;
    },
    close: async () => {
      await streamWriter.close();
      release();
    },
    release,
  };
}

type TerminalSessionEvent = Extract<
  UnstampedMessageStreamEvent,
  { type: "session.completed" | "session.failed" }
>;

/**
 * Publishes a terminal `session.completed` or `session.failed` from outside a
 * turn as the session's own event, through its channel adapter and
 * instrumentation. Stream-event hooks do not run: the ending session may not
 * restore, and no turn scope remains for authored code. Never throws.
 *
 * When the context cannot be restored, the event is only stamped and written so
 * the stream still ends: the one degraded write of a session event.
 */
export async function publishTerminalSessionEvent(input: {
  readonly errorId?: string;
  readonly event: TerminalSessionEvent;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionWritable: WritableStream<Uint8Array>;
  /** The turn the event ends, for instrumentation. */
  readonly turnId?: string;
}): Promise<void> {
  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  const fields = { errorId: input.errorId, sessionId };
  const { type } = input.event;

  let ctx: ContextContainer;
  let publisher: SessionEventPublisher;
  try {
    ctx = await deserializeContext(input.serializedContext);
    publisher = openSessionEventPublisher({
      ctx,
      origin: "own",
      sessionWritable: input.sessionWritable,
    });
  } catch (error) {
    log.error(`failed to restore context for terminal ${type} event`, { ...fields, error });
    await writeUnroutedSessionEvent(input.sessionWritable, input.event).catch((writeError) =>
      log.error(`failed to write terminal ${type} event`, { ...fields, error: writeError }),
    );
    return;
  }

  // Emitted without its hooks; see above.
  const publish: HandleEventFn = async (event) => {
    await publisher.emit(event);
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
  const emit =
    instrumentation?.createHandleEvent({ handleEvent: publish, turnId: input.turnId }) ?? publish;
  try {
    await contextStorage.run(ctx, () => emit(input.event));
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
  event: UnstampedMessageStreamEvent,
): Promise<void> {
  const writer = openSessionEventWriter({ deliveryIds: () => undefined, sessionWritable });
  try {
    await writer.write(event);
  } finally {
    writer.release();
  }
}
