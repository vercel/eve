export type {
  ChannelEvent,
  ChannelEventDecision,
  ChannelOccurrence,
  ChannelOnEvent,
  ChannelOnSubscribe,
  ChannelSubscriber,
  ChannelSubscription,
  ChannelSubscriptionGrant,
  ChannelSubscriptionRequest,
  ChannelSubscriptionsDefinition,
  EmitChannelEventFn,
} from "#shared/channel-subscriptions.js";
export { describeGitHubEvent, type GitHubOnEvent } from "#public/channels/github/subscriptions.js";
