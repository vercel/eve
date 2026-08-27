import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession } from "#execution/session.js";
import { removeTaskAgentAddressFromState } from "#harness/handles/transitions.js";
import type { HarnessSession } from "#harness/types.js";
import {
  createTaskUpdatedEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { toClientTaskView } from "#tasks/client.js";
import { cacheTerminalTaskView, findSessionTaskEntry } from "#tasks/session-index.js";
import {
  isTerminalTaskStatus,
  readSubagentTaskMetadata,
  sameTaskMetadata,
  type TaskView,
} from "#tasks/types.js";

export interface TaskViewDelivery {
  readonly message?: string;
  readonly view: TaskView;
}

/** Validates and emits task views onto their owning parent session stream. */
export async function emitTaskViewDeliveriesStep(input: {
  readonly deliveries: readonly TaskViewDelivery[];
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  let state = durableSession.state;
  const accepted: TaskViewDelivery[] = [];

  for (const delivery of input.deliveries) {
    const entry = findSessionTaskEntry(state, delivery.view.taskId);
    if (entry === undefined || !sameTaskMetadata(entry.metadata, delivery.view.metadata)) continue;
    accepted.push(delivery);

    if (!isTerminalTaskStatus(delivery.view.status)) continue;
    state = cacheTerminalTaskView(state, delivery.view);
    if (delivery.view.executor?.lifecycle !== "terminal") continue;
    const metadata = readSubagentTaskMetadata(delivery.view);
    if (metadata !== undefined) state = removeTaskAgentAddressFromState(state, metadata.agentId);
  }

  if (accepted.length === 0) {
    return { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
    durable: { ...durableSession, state },
    turnAgent: effectiveAgent.turnAgent,
  });
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const writer = input.parentWritable.getWriter();

  let scopedSession: HarnessSession;
  try {
    const result = await withContextScope(ctx, session, async (enrichedSession) => {
      for (const delivery of accepted) {
        const event = createTaskUpdatedEvent({
          message: delivery.message,
          task: toClientTaskView(delivery.view),
        });
        const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
        const stamped = stampMessageStreamEvent(transformed);
        await writer.write(encodeMessageStreamEvent(stamped));
        await dispatchStreamEventHooks({ ctx, event: stamped, registry: bundle.hookRegistry });
      }
      return { result: undefined, session: enrichedSession };
    });
    scopedSession = result.session;
  } finally {
    writer.releaseLock();
  }

  setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
  const nextSession = reconcileSessionContinuationToken(ctx, scopedSession);
  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session: nextSession }),
  };
}
