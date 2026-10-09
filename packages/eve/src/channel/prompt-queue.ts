import { firstOpenRequest } from "#channel/interaction-prompts.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type {
  InteractionOpenedData,
  InteractionSettledData,
} from "#protocol/session-events/families/interaction.js";
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
 * tables as of the event's commit, so a request that closed never shows, and
 * one the channel failed to show is tried again on the next event. `show`
 * returns `false` when it could not show the request.
 */
export function promptQueueEvents<TChannel extends { state: PromptQueueState }>(
  show: (channel: TChannel, request: InputRequest) => Promise<boolean | void>,
) {
  async function refresh(channel: TChannel, view: SessionView) {
    const first = firstOpenRequest(view);
    if (first === undefined) {
      delete channel.state.shownPromptId;
      return;
    }
    if (first.requestId === channel.state.shownPromptId) return;
    if ((await show(channel, first)) === false) return;
    channel.state.shownPromptId = first.requestId;
  }

  return {
    async "interaction.opened"(
      _data: InteractionOpenedData,
      channel: TChannel,
      ctx: { readonly view: SessionView },
    ): Promise<void> {
      await refresh(channel, ctx.view);
    },
    async "interaction.settled"(
      _data: InteractionSettledData,
      channel: TChannel,
      ctx: { readonly view: SessionView },
    ): Promise<void> {
      await refresh(channel, ctx.view);
    },
  };
}
