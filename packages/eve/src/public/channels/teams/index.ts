export type { ModelMessage } from "ai";

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
  type TeamsChannelCredentials,
  type TeamsChannelEvents,
  type TeamsChannelState,
  type TeamsContext,
  type TeamsEventContext,
  type TeamsHandle,
  type TeamsInboundResult,
  type TeamsInboundResultOrPromise,
  type TeamsInputResponseResult,
  type TeamsInvokeResult,
  type TeamsInvokeResultOrPromise,
  type TeamsReceiveTarget,
  type TeamsRequestOptions,
  type TeamsThread,
} from "#public/channels/teams/teamsChannel.js";

export {
  callTeamsConnectorApi,
  normalizeTeamsPostInput,
  replyToTeamsActivity,
  resolveTeamsAccessToken,
  resolveTeamsAppId,
  resolveTeamsAppPassword,
  resolveTeamsTenantId,
  sendTeamsActivity,
  splitTeamsMessageText,
  teamsContinuationToken,
  triggerTeamsTypingIndicator,
  updateTeamsActivity,
  TEAMS_MESSAGE_TEXT_MAX_LENGTH,
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
  formatTeamsContextBlock,
  isTeamsPersonalMessage,
  parseTeamsActivity,
  teamsThreadRootActivityId,
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
  deriveTeamsInputResponses,
  isTeamsInputResponseActivity,
  renderAnsweredInputRequestMessage,
  renderInputRequestAttachment,
  renderInputRequestMessage,
  teamsInvokeResponse,
  TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
  TEAMS_HITL_CHOICE_INPUT_ID,
  TEAMS_HITL_DATA_KEY,
  TEAMS_HITL_FREEFORM_INPUT_ID,
} from "#public/channels/teams/hitl.js";

export {
  collectTeamsFileParts,
  buildTeamsTurnMessage,
  createTeamsFetchFile,
  normalizeTeamsFilesPolicy,
  type TeamsFilesConfig,
  type TeamsFilesPolicy,
} from "#public/channels/teams/attachments.js";

export {
  buildAuthCompletedText,
  defaultTeamsAuth,
  formatConnectionDisplayName,
  teamsMentionUser,
} from "#public/channels/teams/defaults.js";

export {
  verifyTeamsJwt,
  verifyTeamsRequest,
  type TeamsJwtVerifyOptions,
  type TeamsVerifyOptions,
  type TeamsWebhookVerifier,
} from "#public/channels/teams/verify.js";
