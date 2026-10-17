// ---------------------------------------------------------------------------
// Client and ClientSession
// ---------------------------------------------------------------------------

export { EveAgentStore } from "#client/eve-agent-store.js";
export { Client } from "#client/client.js";
export { AgentInfoResponseError } from "#client/agent-info-error.js";
export { HealthResponseError } from "#client/health-response-error.js";
export { ClientError, ClientSessionStrandedError } from "#client/client-error.js";
export { conversationOf } from "#client/conversation.js";
export {
  transcriptOf,
  type TranscriptData,
  type TranscriptMessage,
  type TranscriptOptions,
} from "#client/transcript.js";

export type {
  AgentObservation,
  ConversationAgentSession,
  ConversationState,
} from "#client/conversation-state.js";
export type {
  MessageContent,
  MessageFilePart,
  MessagePart,
  MessageTextPart,
} from "#shared/message-content.js";
export type { Delivery } from "#shared/delivery.js";
export { SessionNotActiveError } from "#channel/session-not-active-error.js";
export type { ClientAgentSession } from "#client/agent-session.js";
export type { ClientSession } from "#client/session.js";
export type {
  ClientSessions,
  CreatedClientSession,
  CreatedIdleClientSession,
} from "#client/sessions.js";

// ---------------------------------------------------------------------------
// Client types
// ---------------------------------------------------------------------------

export type {
  EveAgentStoreCallbacks,
  EveAgentStoreInit,
  EveAgentStoreSnapshot,
  EveAgentStoreStatus,
  PrepareSend,
} from "#client/eve-agent-store.js";

export type {
  AgentInfoEntry,
  AgentInfoChannelEntry,
  AgentInfoChannels,
  AgentInfoConnectionEntry,
  AgentInfoDynamicResolverEntry,
  AgentInfoHookEntry,
  AgentInfoInstructions,
  AgentInfoInstructionsEntry,
  AgentInfoResult,
  AgentInfoRemoteAgentEntry,
  AgentInfoSandboxEntry,
  AgentInfoScheduleEntry,
  AgentInfoSkillEntry,
  AgentInfoSource,
  AgentInfoSubagentEntry,
  AgentInfoToolEntry,
  AgentInfoTools,
  ClientAuth,
  ClientOptions,
  ClientRedirectPolicy,
  CreateSessionOptions,
  HeadersValue,
  HealthResult,
  DeliveryResult,
  RespondTurnOptions,
  SendTurnInput,
  SendTurnOptions,
  SessionSnapshot,
  ClientSessionState,
  SessionStreamOptions,
  StreamReconnectPolicy,
  StreamReconnectRetryPolicy,
  TokenValue,
} from "#client/types.js";

export type {
  EveInteractionPart,
  EveMessage,
  EveMessageMetadata,
  EveMessagePart,
  EveToolPart,
} from "#client/message-types.js";

export type {
  SessionEvent,
  SessionEventMeta,
  SessionStreamEvent,
} from "#protocol/session-event.js";
export { endsTurn, failureOf } from "#client/session-utils.js";

export type { AskedCall } from "#protocol/session-reader.js";
export { isAnswer, parseAnswer, parseAnswers } from "#shared/input.js";

export type { AgentInfoMemoryEntry } from "#client/types.js";
