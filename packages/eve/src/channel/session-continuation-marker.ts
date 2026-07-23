import type { Runtime } from "#channel/types.js";

/** Builds channel-scoped controls for workflow-owned continuation state. */
export function createSetSessionContinuationMarkerFn(
  runtime: Runtime,
  channelName: string,
):
  | ((options: {
      readonly active: boolean;
      readonly continuationToken: string;
      readonly key: string;
    }) => Promise<void>)
  | undefined {
  const setSessionContinuationMarker = runtime.setSessionContinuationMarker;
  if (setSessionContinuationMarker === undefined) return undefined;

  return async (options): Promise<void> => {
    await setSessionContinuationMarker({
      active: options.active,
      continuationToken: `${channelName}:${options.continuationToken}`,
      key: options.key,
    });
  };
}
