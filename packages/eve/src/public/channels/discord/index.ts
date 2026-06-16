/**
 * AI SDK conversation-message shape that the harness uses as the unit of
 * session history and turn input. Re-exported from the `ai` package so
 * authors wiring up the Discord channel can type their own message arrays
 * without taking a direct `ai` dependency.
 */
export type { ModelMessage } from "ai";

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
  type DiscordChannelCredentials,
  type DiscordChannelEvents,
  type DiscordChannelState,
  type DiscordCommandResult,
  type DiscordCommandResultOrPromise,
  type DiscordContext,
  type DiscordEventContext,
  type DiscordHandle,
  type DiscordReceiveTarget,
  type DiscordRequestOptions,
} from "#public/channels/discord/discordChannel.js";

export {
  callDiscordApi,
  createDiscordFollowupMessage,
  discordContinuationToken,
  DISCORD_MESSAGE_CONTENT_MAX_LENGTH,
  DISCORD_NO_MENTIONS,
  editDiscordOriginalResponse,
  resolveDiscordApplicationId,
  resolveDiscordBotToken,
  resolveDiscordPublicKey,
  sendDiscordChannelMessage,
  splitDiscordMessageContent,
  triggerDiscordTypingIndicator,
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
  DISCORD_EPHEMERAL_MESSAGE_FLAG,
  DISCORD_INTERACTION_RESPONSE_TYPE,
  DISCORD_INTERACTION_TYPE,
  commandInteractionMessage,
  formatDiscordContextBlock,
  parseDiscordInteraction,
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

export {
  DISCORD_COMPONENT_TYPE,
  DISCORD_HITL_CUSTOM_ID_PREFIX,
  DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX,
  DISCORD_HITL_FREEFORM_TEXT_INPUT_ID,
  buildFreeformModalResponse,
  deriveComponentInputResponses,
  deriveModalInputResponses,
  isDiscordFreeformComponent,
  renderInputRequestComponents,
} from "#public/channels/discord/hitl.js";

export { defaultDiscordAuth } from "#public/channels/discord/defaults.js";

export {
  verifyDiscordRequest,
  verifyDiscordSignature,
  type DiscordPublicKey,
  type DiscordVerifyOptions,
  type DiscordWebhookVerifier,
} from "#public/channels/discord/verify.js";
