/**
 * Instrumentation metadata the channel's `metadata` callback reports for
 * Discord sessions, used for tracing and observability.
 */
export interface DiscordInstrumentationMetadata extends Record<string, unknown> {
  /** Originating Discord channel id, or `null` when unavailable. */
  readonly channelId: string | null;
  /** Originating Discord guild id, or `null` when the interaction was not in a guild. */
  readonly guildId: string | null;
}

export {
  discordChannel,
  type DiscordChannel,
  type DiscordChannelConfig,
  type DiscordChannelContext,
  type DiscordChannelCredentials,
  type DiscordChannelEvents,
  type DiscordChannelState,
  type DiscordCommandResult,
  type DiscordCommandResultOrPromise,
  type DiscordContext,
  type DiscordEventContext,
  type DiscordHandle,
  type DiscordAnswerContext,
  type DiscordAnswerInteraction,
  type DiscordAnswerResult,
  type DiscordReceiveTarget,
  type DiscordRequestOptions,
} from "#public/channels/discord/discordChannel.js";

export {
  discordContinuationToken,
  type DiscordApiOptions,
  type DiscordApiResponse,
  type DiscordApplicationId,
  type DiscordBotToken,
  type DiscordCredentials,
  type DiscordFetch,
  type DiscordMessageBody,
  type DiscordPostedMessage,
} from "#public/channels/discord/api.js";

export {
  type DiscordCommandInteraction,
  type DiscordCommandOption,
  type DiscordComponentInteraction,
  type DiscordInboundContext,
  type DiscordInteraction,
  type DiscordInteractionBase,
  type DiscordMember,
  type DiscordModalSubmitInteraction,
  type DiscordUser,
} from "#public/channels/discord/inbound.js";

export { defaultDiscordAuth } from "#public/channels/discord/defaults.js";

export {
  type DiscordPublicKey,
  type DiscordWebhookVerifier,
} from "#public/channels/discord/verify.js";
