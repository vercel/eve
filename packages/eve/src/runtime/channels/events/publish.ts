import { installedDurableHost } from "#execution/hosts.js";
import { channelEventId } from "#runtime/channels/events/id.js";
import type { ChannelSubscriptions, PublishChannelEventFn } from "#shared/channel-subscriptions.js";
import { parseJsonObject } from "#shared/json.js";
import { defineJsonSchema } from "#tools/schema.js";

/** Builds the `publish` function a channel's routes receive, bound to the channel's own events. */
export function createPublishChannelEventFn(
  channelName: string,
  subscriptions: ChannelSubscriptions | undefined,
): PublishChannelEventFn {
  return async (event, input, delivery) => {
    const definition = subscriptions?.[event];
    if (definition === undefined)
      throw new Error(`Channel "${channelName}" does not offer the event "${event}".`);
    const validated = await defineJsonSchema(definition.inputSchema)["~standard"].validate(input);
    if (validated.issues !== undefined)
      throw new Error(
        `Published "${event}" input does not match the event's schema: ${validated.issues.map(({ message }) => message).join("; ")}`,
      );
    const args = parseJsonObject(
      definition.normalize?.(parseJsonObject(validated.value)) ?? validated.value,
    );
    const owners = installedDurableHost()?.channelEvents;
    if (owners === undefined) return false;
    return owners.publish(channelEventId(channelName, event, args), delivery);
  };
}
