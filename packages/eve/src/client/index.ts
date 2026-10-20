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
export { createDataUrlFilePart, createTextWithFileContent } from "#client/file-parts.js";
export type {
  MessageContent,
  MessageFilePart,
  MessagePart,
  MessageTextPart,
} from "#shared/message-content.js";
export { MessageResponse } from "#client/message-response.js";
export { ClientAgentSession } from "#client/agent-session.js";
export { ClientSession } from "#client/session.js";
export {
  ClientSessions,
  type CreatedClientSession,
  type CreatedIdleClientSession,
} from "#client/sessions.js";

// ---------------------------------------------------------------------------
// Client types
// ---------------------------------------------------------------------------

export type {
  AcceptedDelivery,
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
  CancelSessionResult,
  ClearResult,
  CompactResult,
  ClientAuth,
  ClientOptions,
  ClientRedirectPolicy,
  CreateSessionOptions,
  HeadersValue,
  HealthResult,
  MessageResult,
  RespondTurnOptions,
  ResetResult,
  ResolvedStreamReconnectPolicy,
  SendTurnInput,
  SendTurnOptions,
  SessionSnapshot,
  ClientSessionState,
  StreamOptions,
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

// ---------------------------------------------------------------------------
// Stream event types (re-exported so consumers can type-narrow without
// importing from the main package).
// ---------------------------------------------------------------------------

export type {
  TraceContext,
  SessionPredecessor,
} from "#protocol/session-events/families/session.js";
export type {
  SessionEvent,
  SessionEventMeta,
  SessionStreamEvent,
} from "#protocol/session-event.js";
export type * from "#protocol/session-events/index.js";
export { endsTurn, failureOf } from "#client/session-utils.js";

export type { SessionView, SessionPreviews } from "#protocol/session-projection/tables.js";
export type { Answer } from "#shared/input.js";
export type { Interaction, AskedCall } from "#protocol/session-reader.js";
export { signInEnding } from "#protocol/session-reader.js";
export { isAnswer, parseAnswer, parseAnswers } from "#shared/input.js";

export type { ToolStub, ToolStubOutcome } from "#tool-stubs/types.js";
