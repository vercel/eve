import { installedDurableHost } from "#execution/hosts.js";
import { channelEventKey } from "#runtime/subscriptions/id.js";
import type { EmitChannelEventFn } from "#shared/channel-subscriptions.js";

export function createEmitChannelEventFn(channelName: string): EmitChannelEventFn {
  return async (event, input, occurrence) => {
    const owners = installedDurableHost()?.subscriptions;
    if (owners === undefined)
      throw new Error("Subscriptions are not supported on this host. Run from a deployed agent.");
    return owners.emit(
      { kind: "channel", name: channelName },
      channelEventKey(event, input),
      occurrence,
    );
  };
}
