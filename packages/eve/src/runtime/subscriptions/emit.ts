import { installedDurableHost } from "#execution/hosts.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { checkEventInput, closestEventsHint } from "#runtime/subscriptions/event-definitions.js";
import { channelEventKey } from "#runtime/subscriptions/id.js";
import type { ChannelEventDefinition, EmitChannelEventFn } from "#shared/channel-subscriptions.js";

export function createEmitChannelEventFn(
  channelName: string,
  events: readonly ChannelEventDefinition[] | undefined,
  compiledArtifactsSource: () => RuntimeCompiledArtifactsSource,
): EmitChannelEventFn {
  return async (event, input, occurrence) => {
    const definition = events?.find((candidate) => candidate.name === event);
    if (definition === undefined)
      throw new Error(
        `Channel "${channelName}" does not declare the event "${event}", so nobody could subscribe to it.${closestEventsHint(event, events ?? [])}`,
      );
    const scope = await checkEventInput(definition, input);
    const owners = installedDurableHost()?.subscriptions;
    if (owners === undefined)
      throw new Error("Subscriptions are not supported on this host. Run from a deployed agent.");
    return owners.emit(
      channelName,
      channelEventKey(event, scope),
      occurrence,
      compiledArtifactsSource(),
    );
  };
}
