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
  ClientAuth,
  ClientOptions,
  ClientRedirectPolicy,
  HeadersValue,
  HealthResult,
  MessageResult,
  SendTurnInput,
  SendTurnPayload,
  SessionState,
  StreamOptions,
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
  InputRequestedStreamEvent,
  MessageAppendedStreamEvent,
  MessageCompletedStreamEvent,
  MessageReceivedStreamEvent,
  ReasoningAppendedStreamEvent,
  ReasoningCompletedStreamEvent,
  ResultCompletedStreamEvent,
  SessionCompletedStreamEvent,
  SessionFailedStreamEvent,
  SessionStartedStreamEvent,
  SessionWaitingStreamEvent,
  StepCompletedStreamEvent,
  StepFailedStreamEvent,
  StepStartedStreamEvent,
  SubagentCalledStreamEvent,
  SubagentChildEventStreamEvent,
  SubagentCompletedStreamEvent,
  SubagentStartedStreamEvent,
  TurnCompletedStreamEvent,
  TurnFailedStreamEvent,
  TurnStartedStreamEvent,
  TurnFailureStreamEvent,
} from "#protocol/message.js";

export { isCurrentTurnBoundaryEvent, isTurnFailureEvent } from "#protocol/message.js";

export type { InputOption, InputRequest, InputResponse } from "#runtime/input/types.js";
export {
  inputOptionSchema,
  inputRequestSchema,
  inputResponseSchema,
  isInputRequest,
  isInputResponse,
} from "#runtime/input/types.js";

export { resolveTextToResponse, resolveTextToResponses } from "#channel/resolve-text.js";
