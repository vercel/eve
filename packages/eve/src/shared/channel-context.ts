import type { SessionInfo } from "#context/session-context.js";

/** Channel routing authority; changing an address does not send input or control a session. */
export interface ChannelContinuationOps {
  readonly continuation?: {
    readonly token: string;
    alias(token: string): void;
  };
}

/** Live inputs to a channel's context factory, separate from operable session handles. */
export interface ChannelContext extends ChannelContinuationOps {
  readonly session: Pick<SessionInfo, "id" | "auth">;
}
