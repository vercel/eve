import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { TurnDeliveryIdsKey } from "#context/keys.js";
import * as activityCohort from "#execution/activity-cohort.js";
import { setChannelContext } from "#execution/channel-context.js";
import { observeSessionActivity } from "#execution/session-activity-projection.js";
import { forwardEventToRemoteCaller } from "#subagents/remote-caller-events.js";
import {
  encodeMessageStreamEvent,
  type MessageStreamEvent,
  stampMessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

export interface SessionEventSinkInput {
  readonly adapter: ChannelAdapter;
  readonly ctx: ContextContainer;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly sessionId: string;
}

export interface PublishedSessionEvent {
  readonly event: MessageStreamEvent;
  readonly suppressed: boolean;
}

export interface SessionEventSink {
  readonly adapterCtx: ReturnType<typeof buildAdapterContext>;
  emit(event: UnstampedMessageStreamEvent): Promise<PublishedSessionEvent>;
  /** Closes the parent stream; only a terminal `done` step does this. */
  close(): Promise<void>;
  /** Releases the writer lock so the next step can acquire it. Safe after `close()`. */
  release(): void;
}

/** Publishes events without executing hooks or preparing model context. */
export function createSessionEventSink(input: SessionEventSinkInput): SessionEventSink {
  const { adapter, ctx } = input;
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const writer = input.sessionWritable.getWriter();

  const deliver = async (event: UnstampedMessageStreamEvent): Promise<PublishedSessionEvent> => {
    const toEmit = await callAdapterEventHandler(adapter, event, adapterCtx);
    await forwardEventToRemoteCaller({ ctx, event: toEmit, sessionId: input.sessionId });
    setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
    const stamped = stampMessageStreamEvent(toEmit, ctx.get(TurnDeliveryIdsKey));
    await writer.write(encodeMessageStreamEvent(stamped));
    return { event: stamped, suppressed: false };
  };

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    writer.releaseLock();
  };
  return {
    adapterCtx,
    async emit(event) {
      activityCohort.updateActivityBlockers(ctx, event);
      const emitted = await deliver(event);
      void observeSessionActivity({ ctx, event: emitted.event, sessionId: input.sessionId });
      return emitted;
    },
    close: async () => {
      await writer.close();
      release();
    },
    release,
  };
}
