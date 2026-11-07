import type { SlackBotToken } from "#public/channels/slack/api.js";
import type { SlackTransportOptions } from "#public/channels/slack/transport.js";

/** The outbound Slack settings a channel was built with. */
export interface SlackChannelTransport {
  readonly api: SlackTransportOptions | undefined;
  readonly botToken: SlackBotToken | undefined;
}

// Keyed by the channel object so tools reach its credentials without the
// channel exposing them as a public property.
const transports = new WeakMap<object, SlackChannelTransport>();

export function registerSlackChannelTransport(
  channel: object,
  transport: SlackChannelTransport,
): void {
  transports.set(channel, transport);
}

export function slackChannelTransport(channel: object): SlackChannelTransport | undefined {
  return transports.get(channel);
}
