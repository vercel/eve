import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { ModeKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  createDurableSessionState,
  type DurableSession,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession } from "#execution/session.js";
import {
  emitTurnEpilogue,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import { emitProxiedInputRequest } from "#subagents/hitl-proxy.js";
import { upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { AnswerHookRoute, ProxyInputRequest } from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { encodeMessageStreamEvent, stampMessageStreamEvent } from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import type { RunMode } from "#shared/run-mode.js";
import { stopTaskClock } from "#tasks/clock.js";

type SubagentEventHookPayload =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

type ProxyInputRequestEntries = readonly (readonly [requestId: string, route: ProxyInputRequest])[];

interface ProxySubagentEventResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Proxies one child event through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(input: {
  readonly answerHook?: AnswerHookRoute;
  readonly hookPayload: SubagentEventHookPayload;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  /** The owner's task for the child; stamped on proxied input and authorization events. */
  readonly taskId?: string;
}): Promise<ProxySubagentEventResult> {
  "use step";

  const durableSession = readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);

  return emitProxiedSubagentEvent({
    answerHook: input.answerHook,
    ctx,
    durableSession,
    hookPayload: input.hookPayload,
    now: new Date().toISOString(),
    sessionWritable: input.sessionWritable,
    taskId: input.taskId,
  });
}

/** Applies one proxied child event to an already-hydrated parent context. */
export async function emitProxiedSubagentEvent(input: {
  readonly answerHook?: AnswerHookRoute;
  readonly ctx: ContextContainer;
  readonly durableSession: DurableSession;
  readonly hookPayload: SubagentEventHookPayload;
  /** When the request reached this owner; it stops the task's deadline clock. */
  readonly now?: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly taskId?: string;
}): Promise<ProxySubagentEventResult> {
  const { ctx } = input;
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: effectiveAgent.thresholdPercent,
    },
    durable: input.durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const writer = input.sessionWritable.getWriter();

  let proxyEntries: ProxyInputRequestEntries | undefined;
  let scopedSession: HarnessSession;
  try {
    // A re-emitted child event is a distinct event on the parent stream, so it
    // gets its own id rather than the child's.
    const emit = async (event: UnstampedMessageStreamEvent): Promise<void> => {
      const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
      await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(transformed)));
    };

    const scopeResult = await withContextScope(ctx, session, async (enrichedSession) => {
      if (input.hookPayload.kind === "subagent-authorization-event") {
        await emit(withTaskId(input.hookPayload.event, input.taskId));
        return {
          result: undefined,
          session: await closeStandaloneAuthorizationEvent({
            emit,
            eventType: input.hookPayload.event.type,
            mode: ctx.require(ModeKey),
            session: enrichedSession,
          }),
        };
      }

      const proxyResult = await emitProxiedInputRequest({
        emit,
        hookPayload: input.hookPayload,
        mode: ctx.require(ModeKey),
        session: enrichedSession,
        taskId: input.taskId,
      });
      return { result: proxyResult.entries, session: proxyResult.session };
    });
    proxyEntries = scopeResult.result;
    scopedSession = scopeResult.session;
  } finally {
    writer.releaseLock();
  }

  setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });

  if (proxyEntries !== undefined && input.hookPayload.kind === "subagent-input-request") {
    const { answerHook, taskId } = input;
    scopedSession = upsertProxyInputRequests({
      entries: proxyEntries.map(([requestId, route]) => {
        const tagged: { -readonly [K in keyof ProxyInputRequest]: ProxyInputRequest[K] } = {
          ...route,
        };
        if (answerHook !== undefined) tagged.answerHook = answerHook;
        if (taskId !== undefined) tagged.taskId = taskId;
        return [requestId, tagged] as const;
      }),
      forChildContinuationToken: input.hookPayload.childContinuationToken,
      session: scopedSession,
    });
    if (taskId !== undefined) {
      scopedSession = stopTaskClock(scopedSession, {
        now: input.now ?? new Date().toISOString(),
        requests: input.hookPayload.event.requests,
        taskId,
      });
    }
  }

  const nextSession = reconcileSessionContinuationToken(ctx, scopedSession);

  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session: nextSession }),
  };
}

/** Attributes a proxied authorization to the owner's task, replacing any descendant's. */
function withTaskId(
  event: SubagentAuthorizationEvent,
  taskId: string | undefined,
): SubagentAuthorizationEvent {
  if (taskId === undefined) return event;
  switch (event.type) {
    case "authorization.required":
      return { ...event, data: { ...event.data, taskId } };
    case "authorization.completed":
      return { ...event, data: { ...event.data, taskId } };
    default:
      return event;
  }
}

async function closeStandaloneAuthorizationEvent(input: {
  readonly emit: (event: UnstampedMessageStreamEvent) => Promise<void>;
  readonly eventType: SubagentAuthorizationEventHookPayload["event"]["type"];
  readonly mode: RunMode;
  readonly session: HarnessSession;
}): Promise<HarnessSession> {
  if (
    input.mode !== "conversation" ||
    (input.eventType !== "authorization.required" && input.eventType !== "authorization.completed")
  ) {
    return input.session;
  }

  const state = getHarnessEmissionState(input.session.state);
  const nextState = await emitTurnEpilogue(input.emit, state, input.mode);
  return setHarnessEmissionState(input.session, nextState);
}
