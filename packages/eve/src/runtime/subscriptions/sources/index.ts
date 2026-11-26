import { channelSource } from "#runtime/subscriptions/sources/channel.js";
import { connectionSource } from "#runtime/subscriptions/sources/connection.js";
import type { SubscriptionSourceRuntime } from "#runtime/subscriptions/sources/types.js";
import type { SubscriptionSource } from "#runtime/subscriptions/state.js";

const SOURCES: Record<SubscriptionSource["kind"], SubscriptionSourceRuntime> = {
  channel: channelSource,
  connection: connectionSource,
};

export function subscriptionSource(kind: SubscriptionSource["kind"]): SubscriptionSourceRuntime {
  return SOURCES[kind];
}
