import type { ChannelAdapter } from "#channel/adapter.js";
import type { SlackBotToken } from "#public/channels/slack/api.js";
import type { SlackTransportOptions } from "#public/channels/slack/transport.js";

const SLACK_OBSERVATION = Symbol.for("eve.channel.slack.runObservation.v1");

export interface SlackObservationPresentation {
  readonly api?: SlackTransportOptions;
  readonly botToken?: SlackBotToken;
}

type ObservationAdapter = ChannelAdapter & {
  readonly [SLACK_OBSERVATION]?: SlackObservationPresentation;
};

export function attachSlackObservation(
  adapter: ChannelAdapter,
  config: SlackObservationPresentation,
): void {
  Object.defineProperty(adapter, SLACK_OBSERVATION, { value: config });
}

export function getSlackObservation(
  adapter: ChannelAdapter,
): SlackObservationPresentation | undefined {
  return (adapter as ObservationAdapter)[SLACK_OBSERVATION];
}

export function copySlackObservation(source: ChannelAdapter, target: ChannelAdapter): void {
  const config = getSlackObservation(source);
  if (config !== undefined) attachSlackObservation(target, config);
}
