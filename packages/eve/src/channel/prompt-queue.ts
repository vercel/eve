import { firstOpenRequest } from "#channel/interaction-prompts.js";
import { sessionTables, type SessionView } from "#protocol/session-projection/session-view.js";
import type { Interaction } from "#channel/interaction-prompts.js";

/**
 * Channel state for showing a session's open requests one at a time. A typed
 * reply answers the first open request, so a channel that can only show text
 * shows that one and holds the rest until it is answered.
 */
export interface PromptQueueState {
  /** @internal The request the channel last showed, which a typed reply answers. */
  shownPromptId?: string;
}

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
