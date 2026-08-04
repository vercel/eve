// ---------------------------------------------------------------------------
// Client and ClientSession
// ---------------------------------------------------------------------------

export { EveAgentStore } from "#client/eve-agent-store.js";
export { Client } from "#client/client.js";
export { AgentInfoResponseError } from "#client/agent-info-error.js";
export { ClientError } from "#client/client-error.js";
export { defaultMessageReducer } from "#client/message-reducer.js";
export { createDataUrlFilePart, createTextWithFileContent } from "#client/file-parts.js";
export { MessageResponse } from "#client/message-response.js";
export { ClientSession } from "#client/session.js";
export { ClientSessions, type CreatedClientSession } from "#client/sessions.js";

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
  AgentInfoFrameworkChannelEntry,
  AgentInfoFrameworkToolEntry,
  AgentInfoHookEntry,
  AgentInfoInstructions,
  AgentInfoInstructionsEntry,
  AgentInfoResult,
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
  HeadersValue,
  HealthResult,
  MessageResult,
  ResetResult,
  ResolvedStreamReconnectPolicy,
  SendTurnInput,
  SendTurnPayload,
  SessionSnapshot,
  ClientSessionState,
  StreamOptions,
  StreamReconnectPolicy,
  StreamReconnectRetryPolicy,
  TokenValue,
} from "#client/types.js";

export type {
  EveAgentReducer,
  EveAgentReducerEvent,
  ClientInputRespondedEvent,
  ClientMessageFailedEvent,
  ClientMessageSubmittedEvent,
} from "#client/reducer.js";

export type {
  EveAuthorizationChallenge,
  EveAuthorizationOutcome,
  EveAuthorizationPart,
  EveMessageData,
  EveDynamicToolPart,
  EveMessageInputRequest,
  EveMessage,
  EveMessageMetadata,
  EveMessagePart,
  EveMessageToolMetadata,
} from "#client/message-reducer.js";

// ---------------------------------------------------------------------------
// Stream event types (re-exported so consumers can type-narrow without
// importing from the main package).
// ---------------------------------------------------------------------------

export type {
  ActionPartialStreamEvent,
  ActionResultStreamEvent,
  ActionsRequestedStreamEvent,
  AssistantStepFinishReason,
  AuthorizationOutcome,
  CompactionCompletedStreamEvent,
  CompactionRequestedStreamEvent,
  AuthorizationCompletedStreamEvent,
  ConnectionAuthorizationOutcome,
  AuthorizationRequiredStreamEvent,
  HandleMessageStreamEvent,
  MessageStreamEventMeta,
  InputRequestedStreamEvent,
  MessageAppendedStreamEvent,
  MessageCompletedStreamEvent,
  MessageReceivedPart,
  MessageReceivedStreamEvent,
  ReasoningAppendedStreamEvent,
  ReasoningCompletedStreamEvent,
  ResultCompletedStreamEvent,
  SessionCompletedStreamEvent,
  SessionFailedStreamEvent,
  SessionStartedStreamEvent,
  SessionWaitingStreamEvent,
  MessageStreamEvent,
  StepCompletedStreamEvent,
  StepFailedStreamEvent,
  StepStartedStreamEvent,
  SubagentCalledStreamEvent,
  SubagentChildEventStreamEvent,
  SubagentCompletedStreamEvent,
  SubagentStartedStreamEvent,
  TurnCancelledStreamEvent,
  TurnCompletedStreamEvent,
  TurnFailedStreamEvent,
  TurnStartedStreamEvent,
  TurnFailureStreamEvent,
} from "#protocol/message.js";

export { isCurrentTurnBoundaryEvent, isTurnFailureEvent } from "#protocol/message.js";

export type {
  InputOption,
  InputRequest,
  InputRequestKind,
  InputResponse,
} from "#runtime/input/types.js";
export {
  inputOptionSchema,
  inputRequestKindSchema,
  inputRequestSchema,
  inputResponseSchema,
  isInputRequest,
  isInputResponse,
} from "#runtime/input/types.js";

export { resolveTextToResponse, resolveTextToResponses } from "#channel/resolve-text.js";
