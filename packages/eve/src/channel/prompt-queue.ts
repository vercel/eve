import { contextStorage } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { firstOpenInput } from "#harness/open-input-request.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { foldSession } from "#protocol/session-projection.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";

/**
 * Channel state for showing a session's open requests one at a time. A typed
 * reply answers the first open request, so a channel that can only show text
 * shows that one and holds the rest until it is answered.
 */
export interface PromptQueueState {
  /** The request the channel last showed, which a typed reply answers. */
  shownPromptId?: string;
}

/**
 * Event handlers that call `show` with the request a typed reply answers now,
 * each time that request changes. They read which requests are open from the
 * session's own record of the events it published, so a request that closed
 * never shows, and one the channel failed to show is tried again on the next
 * event. `show` returns `false` when it could not show the request.
 */
export function promptQueueEvents<TChannel extends { state: PromptQueueState }>(
  show: (channel: TChannel, request: InputRequest) => Promise<boolean | void>,
) {
  async function refresh(channel: TChannel, event: UnstampedMessageStreamEvent) {
    // The session records the event only after its handlers run.
    const first = firstOpenInput(foldSession(publishedProjection(channel), event))?.request;
    if (first === undefined) {
      delete channel.state.shownPromptId;
      return;
    }
    if (first.requestId === channel.state.shownPromptId) return;
    if ((await show(channel, first)) === false) return;
    channel.state.shownPromptId = first.requestId;
  }

  return {
    async "input.requested"(
      data: Extract<UnstampedMessageStreamEvent, { type: "input.requested" }>["data"],
      channel: TChannel,
    ): Promise<void> {
      await refresh(channel, { data, type: "input.requested" });
    },
    async "input.resolved"(
      data: Extract<UnstampedMessageStreamEvent, { type: "input.resolved" }>["data"],
      channel: TChannel,
    ): Promise<void> {
      await refresh(channel, { data, type: "input.resolved" });
    },
    async "approval.settled"(
      data: Extract<UnstampedMessageStreamEvent, { type: "approval.settled" }>["data"],
      channel: TChannel,
    ): Promise<void> {
      await refresh(channel, { data, type: "approval.settled" });
    },
  };
}

/**
 * The session's record as of the last event it published. Throws rather than read an empty
 * record when the step's projection is missing: an empty one would show nothing open, so the
 * next prompt would silently never post.
 */
function publishedProjection(channel: object) {
  // A handler's channel context carries the context of the step that publishes the event.
  const ctx = (channel as { readonly ctx?: ContextReader }).ctx ?? contextStorage.getStore();
  return currentProjection(ctx);
}
