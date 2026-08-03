import type { ClearFn, ClearOptions } from "#channel/routes.js";
import type { ClearSessionResult, Runtime } from "#channel/types.js";

/** Builds a channel-scoped context-clear helper. */
export function createClearFn(runtime: Runtime, channelName: string): ClearFn {
  return async (options: ClearOptions): Promise<ClearSessionResult> =>
    await runtime.dispatchContinuation({
      command: { kind: "clear" },
      continuationToken: `${channelName}:${options.continuationToken}`,
    });
}
