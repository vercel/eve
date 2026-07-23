import type { ResetFn, ResetOptions, ResetResult } from "#channel/routes.js";
import type { Runtime } from "#channel/types.js";

/**
 * Builds a channel-scoped session reset helper. It resolves an owner once and
 * retires that observed session id, so it can never cancel a later owner that
 * claimed the same continuation token.
 */
export function createResetFn(runtime: Runtime, channelName: string): ResetFn {
  return async (options: ResetOptions): Promise<ResetResult> => {
    const continuationToken = `${channelName}:${options.continuationToken}`;
    const owner = await runtime.resolveSession(continuationToken);

    if (owner === undefined) {
      return { status: "no_active_session" };
    }

    await runtime.terminateSession({ reason: options.reason, sessionId: owner.sessionId });

    return { status: "reset", previousSessionId: owner.sessionId };
  };
}
