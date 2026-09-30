import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapterContext } from "#channel/adapter.js";
import { type ContextContainer, contextStorage } from "#context/container.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { ParentSessionKey, TurnDeliveryIdsKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import * as activityCohort from "#execution/activity-cohort.js";
import { setChannelContext } from "#execution/channel-context.js";
import { forwardSessionInput } from "#execution/forward-session-input.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { observeSessionActivity } from "#execution/session-activity-projection.js";
import { hydrateDurableSession } from "#execution/session.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import type { HandleEventFn, HarnessSession } from "#harness/types.js";
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
 * its instrumentation and activity and carry its turn's delivery ids.
 *
 * A relayed event belongs to an exchange this session carries for a child
 * session or a workflow run: the question or sign-in it raised, the turn
 * boundary that question causes here, and the `input.resolved` for the answer
 * this session routes back. This session's instrumentation and activity never
 * track that pending input, so no event of the exchange reaches them; the
 * child records its side as its own.
 */
export type SessionEventOrigin = "own" | "relayed";

/** The session a step publishes to: its stream and the state it starts from. */
export interface SessionStepState {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionWritable: WritableStream<Uint8Array>;
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
  return await publishFromStep(target, "own", events);
}

/** Publishes events of an exchange this session relays; see {@link SessionEventOrigin}. */
export async function relaySessionEvents(
  target: SessionStepState,
  events: readonly UnstampedMessageStreamEvent[],
): Promise<PublishedSessionEvents> {
  return await publishFromStep(target, "relayed", events);
}

async function publishFromStep(
  target: SessionStepState,
  origin: SessionEventOrigin,
  events: readonly UnstampedMessageStreamEvent[],
): Promise<PublishedSessionEvents> {
  if (events.length === 0) {
    return { serializedContext: target.serializedContext, sessionState: target.sessionState };
  }
  const ctx = await deserializeContext(target.serializedContext);
  const { session } = await withSessionEventEmitter(
    {
      ctx,
      durableSession: readDurableSession(target.sessionState),
      origin,
      sessionWritable: target.sessionWritable,
    },
    async (emit, scopedSession) => {
      for (const event of events) await emit(event);
      return { result: undefined, session: scopedSession };
    },
  );
  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({
      session: reconcileSessionContinuationToken(ctx, session),
    }),
  };
}

/**
 * Runs `emitEvents` in the session's context scope with an emit that publishes
 * each event with the given origin. `ctx` is updated in place; the returned
 * session is the one `emitEvents` returns after the scope commits.
 */
export async function withSessionEventEmitter<T>(
  input: {
    readonly ctx: ContextContainer;
    readonly durableSession: DurableSession;
    readonly origin: SessionEventOrigin;
    readonly sessionWritable: WritableStream<Uint8Array>;
    readonly inputSource?: string;
  },
  emitEvents: (
    emit: HandleEventFn,
    session: HarnessSession,
  ) => Promise<{ readonly result: T; readonly session: HarnessSession }>,
): Promise<{ readonly result: T; readonly session: HarnessSession }> {
  const { ctx } = input;
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
    durable: input.durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const instrumentation =
    input.origin === "own"
      ? bindSessionInstrumentation({
          agentName: effectiveAgent.turnAgent.id,
          ctx,
          rootSessionId: session.rootSessionId ?? session.sessionId,
          sessionId: session.sessionId,
        })
      : undefined;

  const sink = openSessionEventStream({
    ctx,
    origin: input.origin,
    sessionId: session.sessionId,
    sessionWritable: input.sessionWritable,
    inputSource: input.inputSource,
  });
  try {
    return await withContextScope(ctx, session, async (enrichedSession) => {
      const publish: HandleEventFn = async (event) => {
        const stamped = await sink.emit(event);
        // Only turn-step events can cancel the running turn; see turn-event-handler.ts.
        await dispatchStreamEventHooks({
          cancelTurn: undefined,
          ctx,
          registry: bundle.hookRegistry,
          event: stamped,
        });
      };
      const emit =
        instrumentation?.createHandleEvent({
          handleEvent: publish,
          turnId: activeTurnId(getHarnessEmissionState(input.durableSession.state)),
        }) ?? publish;
      return await emitEvents(emit, enrichedSession);
    });
  } finally {
    await instrumentation?.flush();
    await sink.flushActivity();
    sink.release();
  }
}

/** A session's stream held by one step. */
export interface SessionEventSink {
  readonly adapterCtx: ChannelAdapterContext;
  /**
   * Routes one event through the channel adapter, then stamps and writes it.
   * Stream-event hooks and instrumentation belong to the caller.
   */
  emit(event: UnstampedMessageStreamEvent): Promise<MessageStreamEvent>;
  /** Closes the session stream; only a terminal `done` step does this. */
  close(): Promise<void>;
  /**
   * Waits for the activity this sink submitted. A step awaits it before it
   * returns, so a host that freezes after the step can't drop a task's settlement.
   */
  flushActivity(): Promise<void>;
  /** Releases the writer lock so the next step can acquire it. Safe after `close()`. */
  release(): void;
}

/**
 * The turn step's sink for its own events. A turn composes the rest of the
 * publication itself: its tool loop binds instrumentation to each model call,
 * and an event's hooks run after that event's memory lifecycle.
 */
export function createSessionEventSink(input: {
  readonly ctx: ContextContainer;
  readonly sessionId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): SessionEventSink {
  return openSessionEventStream({ ...input, origin: "own" });
}

function openSessionEventStream(input: {
  readonly ctx: ContextContainer;
  readonly origin: SessionEventOrigin;
  readonly sessionId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly inputSource?: string;
}): SessionEventSink {
  const { ctx, origin } = input;
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const writer = input.sessionWritable.getWriter();

  const submittedActivity: Promise<void>[] = [];
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    writer.releaseLock();
  };
  return {
    adapterCtx,
    async emit(event) {
      if (origin === "own") activityCohort.updateActivityState(ctx, event);
      const forwarded = await forwardSessionInput(ctx, event, input.inputSource);
      const routed = forwarded
        ? event
        : await callAdapterEventHandler(
            adapter,
            event,
            input.inputSource === undefined
              ? adapterCtx
              : { ...adapterCtx, inputSource: input.inputSource },
          );
      setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
      const stamped = stampMessageStreamEvent(
        routed,
        origin === "own" ? ctx.get(TurnDeliveryIdsKey) : undefined,
      );
      await writer.write(encodeMessageStreamEvent(stamped));
      if (origin === "own") {
        submittedActivity.push(
          observeSessionActivity({ ctx, event: stamped, sessionId: input.sessionId }),
        );
      }
      return stamped;
    },
    close: async () => {
      await writer.close();
      release();
    },
    async flushActivity() {
      await Promise.allSettled(submittedActivity.splice(0));
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
  let sink: SessionEventSink;
  try {
    ctx = await deserializeContext(input.serializedContext);
    sink = createSessionEventSink({ ctx, sessionId, sessionWritable: input.sessionWritable });
  } catch (error) {
    log.error(`failed to restore context for terminal ${type} event`, { ...fields, error });
    await writeUnroutedSessionEvent(input.sessionWritable, input.event).catch((writeError) =>
      log.error(`failed to write terminal ${type} event`, { ...fields, error: writeError }),
    );
    return;
  }

  const publish: HandleEventFn = async (event) => {
    await sink.emit(event);
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
    await sink.flushActivity();
    sink.release();
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
  const writer = sessionWritable.getWriter();
  try {
    await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(event)));
  } finally {
    writer.releaseLock();
  }
}
