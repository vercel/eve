import { firstOpenRequest } from "#channel/interaction-prompts.js";
import { sessionTables, type SessionView } from "#protocol/session-projection/session-view.js";
import type { Interaction } from "#channel/interaction-prompts.js";

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
 * A `committed` handler that calls `show` with the request a typed reply answers now, each time
 * that request changes. It reads which requests are open from the tables as of the commit, so a
 * request that closed never shows, and one the channel failed to show is tried again at the next
 * commit. `show` returns `false` when it could not show the request.
 */
export function promptQueue<TChannel extends { state: PromptQueueState }>(
  show: (channel: TChannel, request: Interaction) => Promise<boolean | void>,
) {
  return async (
    _line: unknown,
    { channel, view }: { readonly channel: TChannel; readonly view: SessionView },
  ): Promise<void> => {
    const first = firstOpenRequest(sessionTables(view));
    if (first === undefined) {
      delete channel.state.shownPromptId;
      return;
    }
    if (first.interactionId === channel.state.shownPromptId) return;
    if ((await show(channel, first)) === false) return;
    channel.state.shownPromptId = first.interactionId;
  };
}
