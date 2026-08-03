import type { ResetFn, ResetOptions, ResetResult } from "#channel/routes.js";
import type { Runtime } from "#channel/types.js";

/**
 * Builds a channel-scoped session reset helper.
 */
export function createResetFn(runtime: Runtime, channelName: string): ResetFn {
  return async (options: ResetOptions): Promise<ResetResult> => {
    const continuationToken = `${channelName}:${options.continuationToken}`;
    return await runtime.dispatchContinuation({
      command: { kind: "reset", reason: options.reason },
      continuationToken,
    });
  };
}
