import type { ResolveActiveSessionFn } from "#channel/routes.js";
import type { Runtime } from "#channel/types.js";

/** Builds a channel-scoped lookup for the active owner of a continuation token. */
export function createResolveActiveSessionFn(
  runtime: Runtime,
  channelName: string,
): ResolveActiveSessionFn {
  return ({ continuationToken }) => runtime.resolveSession(`${channelName}:${continuationToken}`);
}
