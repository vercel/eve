import type { CompactFn, CompactOptions } from "#channel/routes.js";
import type { CompactSessionResult, Runtime } from "#channel/types.js";

/** Builds a channel-scoped manual compaction helper. */
export function createCompactFn(runtime: Runtime, channelName: string): CompactFn {
  return async (options: CompactOptions): Promise<CompactSessionResult> =>
    await runtime.compactSession({
      continuationToken: `${channelName}:${options.continuationToken}`,
    });
}
