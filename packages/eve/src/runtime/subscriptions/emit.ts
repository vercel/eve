import { installedDurableHost } from "#execution/hosts.js";
import type { EmitChannelEventFn } from "#shared/channel-subscriptions.js";

/** Builds the `emit` function a channel's routes receive, bound to the channel's own name. */
export function createEmitChannelEventFn(channelName: string): EmitChannelEventFn {
  return async (key, event) => {
    const owners = installedDurableHost()?.subscriptions;
    if (owners === undefined) return false;
    return owners.emit({ kind: "channel", name: channelName }, key, event);
  };
}
