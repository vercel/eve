/**
 * Instrumentation metadata for Teams sessions, read from the channel state: the
 * Teams team/channel id (`channelId`), the conversation type (`personal`,
 * `groupChat`, `channel`, or platform value), and the team id. Each field is
 * null when the inbound activity did not include it.
 */
export interface TeamsInstrumentationMetadata extends Record<string, unknown> {
  readonly channelId: string | null;
  readonly conversationType: string | null;
  readonly teamId: string | null;
}

export {
  teamsChannel,
  type TeamsChannel,
  type TeamsChannelConfig,
  type TeamsChannelContext,
  type TeamsChannelCredentials,
  type TeamsChannelEvents,
  type TeamsChannelState,
  type TeamsContext,
  type TeamsEventContext,
  type TeamsHandle,
  type TeamsInboundMessageContext,
  type TeamsInboundResult,
  type TeamsInboundResultOrPromise,
  type TeamsAnswerResult,
  type TeamsInvokeResult,
  type TeamsInvokeResultOrPromise,
  type TeamsReceiveTarget,
  type TeamsRequestOptions,
  type TeamsThread,
} from "#public/channels/teams/teamsChannel.js";

export {
  teamsContinuationToken,
  type TeamsAccessTokenResult,
  type TeamsApiOptions,
  type TeamsApiResponse,
  type TeamsAppId,
  type TeamsAppPassword,
  type TeamsAttachment,
  type TeamsChannelAccount,
  type TeamsCredentials,
  type TeamsFetch,
  type TeamsMention,
  type TeamsMessageBody,
  type TeamsOutboundActivity,
  type TeamsPostedActivity,
  type TeamsTenantId,
  type TeamsTokenProvider,
} from "#public/channels/teams/api.js";

export {
  type TeamsActivity,
  type TeamsActivityBase,
  type TeamsConversationAccount,
  type TeamsConversationScope,
  type TeamsConversationUpdateActivity,
  type TeamsInboundContext,
  type TeamsInvokeActivity,
  type TeamsMessageActivity,
} from "#public/channels/teams/inbound.js";

export {
  type TeamsFilesConfig,
  type TeamsFilesPolicy,
} from "#public/channels/teams/attachments.js";

export { defaultTeamsAuth } from "#public/channels/teams/defaults.js";

export { type TeamsWebhookVerifier } from "#public/channels/teams/verify.js";
