import type { CancelSessionFn } from "#channel/routes.js";
import type { Runtime } from "#channel/types.js";

/**
 * Creates a channel-local session cancellation function.
 */
export function createCancelSessionFn(runtime: Runtime, channelName: string): CancelSessionFn {
  return async (input) =>
    await runtime.cancelSession({
      ...input,
      continuationToken: `${channelName}:${input.continuationToken}`,
    });
}
