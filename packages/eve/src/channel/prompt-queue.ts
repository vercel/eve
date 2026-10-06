import type { InputRequest } from "#shared/input.js";

/**
 * Channel state for showing a session's open requests one at a time. A typed
 * reply answers the first open request, so a channel that can only show text
 * shows that one and holds the rest until it is answered.
 */
export interface PromptQueueState {
  /** Open requests in the order a typed reply answers them; the first is shown. */
  promptQueue?: readonly InputRequest[];
}

/**
 * Orders open requests the way a typed reply answers them: a budget prompt first, since the
 * session settles it before anything else, then the rest in the order the session asked.
 */
export function inReplyOrder<T>(items: readonly T[], requestOf: (item: T) => InputRequest): T[] {
  const isLimit = (item: T) => requestOf(item).kind === "session-limit";
  return [...items.filter(isLimit), ...items.filter((item) => !isLimit(item))];
}

/**
 * Event handlers that call `show` with one request at a time: the first open
 * request, then each next one once the shown request is answered or withdrawn.
 * An approval counts as answered once it settles, before the rest of its batch.
 */
export function promptQueueEvents<TChannel extends { state: PromptQueueState }>(
  show: (channel: TChannel, request: InputRequest) => Promise<void>,
) {
  async function update(
    channel: TChannel,
    next: (queue: readonly InputRequest[]) => readonly InputRequest[],
  ) {
    const queue = channel.state.promptQueue ?? [];
    const updated = next(queue);
    channel.state.promptQueue = updated;
    const [shown] = updated;
    if (shown !== undefined && shown.requestId !== queue[0]?.requestId) {
      await show(channel, shown);
    }
  }
  const settle = (channel: TChannel, requestIds: readonly string[]) =>
    update(channel, (queue) => queue.filter((request) => !requestIds.includes(request.requestId)));

  return {
    async "input.requested"(
      event: { readonly requests: readonly InputRequest[] },
      channel: TChannel,
    ): Promise<void> {
      await update(channel, (queue) => {
        const queued = new Set(queue.map((request) => request.requestId));
        const all = [...queue, ...event.requests.filter((r) => !queued.has(r.requestId))];
        return inReplyOrder(all, (request) => request);
      });
    },
    async "input.resolved"(
      event: { readonly resolutions: readonly { readonly requestId: string }[] },
      channel: TChannel,
    ): Promise<void> {
      await settle(
        channel,
        event.resolutions.map((resolution) => resolution.requestId),
      );
    },
    async "approval.settled"(
      event: { readonly requestId: string },
      channel: TChannel,
    ): Promise<void> {
      await settle(channel, [event.requestId]);
    },
  };
}
