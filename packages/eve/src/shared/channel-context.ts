import type { SessionInfo } from "#context/session-context.js";

/** Channel routing authority; changing an address does not send input or control a session. */
export interface ChannelContinuationOps {
  readonly continuation?: {
    readonly token: string;
    alias(token: string): void;
    /**
     * Stops this session answering at an address an earlier `alias` added, so
     * another session can claim it. Payloads that address already accepted
     * stay with this session. The current address can't be released: alias
     * the session's new address first.
     */
    release(token: string): void;
  };
}

/** Live inputs to a channel's context factory, separate from operable session handles. */
export interface ChannelContext extends ChannelContinuationOps {
  readonly session: Pick<SessionInfo, "id" | "auth">;
}
