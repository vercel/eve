import type { CancelFn, CancelOptions } from "#channel/routes.js";
import type { CancelTurnResult, Runtime } from "#channel/types.js";

/**
 * Builds the route-handler `cancel` helper for one channel.
 */
export function createCancelFn(runtime: Runtime, channelName: string): CancelFn {
  return async (options: CancelOptions): Promise<CancelTurnResult> => {
    return await runtime.dispatchContinuation({
      command: { kind: "cancel", turnId: options.turnId },
      continuationToken: `${channelName}:${options.continuationToken}`,
    });
  };
}
