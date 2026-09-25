import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { ScheduleIdKey, TurnDeliveryIdsKey, TurnTaskDeliveryKey } from "#context/keys.js";
import * as activityCohort from "#execution/activity-cohort.js";
import { writeChannelEvent } from "#execution/publish-channel-event.js";
import { observeSessionActivity } from "#execution/session-activity-projection.js";
import { scheduledLaunchDeliveryEvent } from "#execution/scheduled-launch-delivery.js";
import { forwardTaskEventToSessionCallback } from "#execution/task-event-callback.js";
import {
  type MessageStreamEvent,
  stampMessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

export interface SessionEventSinkInput {
  readonly adapter: ChannelAdapter;
  readonly ctx: ContextContainer;
  readonly isFirstTurn: boolean;
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
    const forwardedToTaskParent = await forwardTaskEventToSessionCallback(ctx, event);
    if (forwardedToTaskParent) {
      return {
        event: stampMessageStreamEvent(event, ctx.get(TurnDeliveryIdsKey)),
        suppressed: false,
      };
    }
    const deliverableEvent = scheduledLaunchDeliveryEvent(event, {
      isFirstTurn: input.isFirstTurn,
      isScheduled: ctx.get(ScheduleIdKey) !== undefined,
      taskPhase: ctx.get(TurnTaskDeliveryKey),
    });
    if (deliverableEvent === undefined) {
      return {
        event: stampMessageStreamEvent(event, ctx.get(TurnDeliveryIdsKey)),
        suppressed: true,
      };
    }
    const stamped = await writeChannelEvent({
      adapter,
      adapterCtx,
      ctx,
      writer,
      event: deliverableEvent,
      deliveryIds: ctx.get(TurnDeliveryIdsKey),
    });
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
