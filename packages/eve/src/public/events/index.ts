/**
 * The session event contract: the catalog of facts and progress records a session stream
 * carries, the shared fold that turns them into tables, and the selectors and guards that hooks,
 * channels, and clients read them with. No runtime dependencies.
 *
 * @packageDocumentation
 */

export {
  type Family,
  type FactRole,
  type FactDescriptor,
  SESSION_OUTCOMES,
  DELIVERY_OUTCOMES,
  TURN_OUTCOMES,
  MODEL_OUTCOMES,
  CALL_OUTCOMES,
  TASK_OUTCOMES,
  INTERACTION_OUTCOMES,
  RESPONSE_OUTCOMES,
  CONTEXT_OUTCOMES,
  TERMINAL_OUTCOMES,
  FACT_CATALOG,
  type ProgressDescriptor,
  PROGRESS_CATALOG,
  type FactType,
  type ProgressType,
  isFactType,
  isProgressType,
  isTerminalType,
  isKnownOutcome,
  contentPhase,
} from "#protocol/session-events/catalog.js";

export {
  type StoredLine,
  type CommitLine,
  type ProgressLine,
  type Scope,
  type Envelope,
  type TransportRecord,
  type PositionMarker,
  HEARTBEAT_RECORD,
  LEASE_ENDED_RECORD,
  STREAM_ENDED_RECORD,
  type FactPosition,
  type ReadRecord,
  classifyRecord,
  isStoredLine,
  type Cause,
  type Principal,
  type ErrorInfo,
  type Usage,
  type ValueReference,
  type JsonValue,
  type UserPart,
} from "#protocol/session-events/envelope.js";

export { isTerminal, isCompleted } from "#protocol/session-events/guards.js";

export {
  type Fact,
  type Progress,
  type FactOf,
  type ProgressOf,
} from "#protocol/session-events/facts.js";

export type {
  CallOwner,
  CapabilityKind,
  Capability,
  CallInputData,
  CallRequestedData,
  ClearedBy,
  CallStartedData,
  CallProgressData,
  CallOutcome,
  CallSettledData,
  CallInput,
  CallRequested,
  CallStarted,
  CallProgress,
  CallSettled,
  CallFact,
  CallProgressRecord,
} from "#protocol/session-events/families/call.js";

export type {
  ChildOpenedData,
  ChildOpened,
  ChildFact,
} from "#protocol/session-events/families/child.js";

export type {
  ContentKind,
  ContentPhase,
  ContentDeltaData,
  ContentCompletedData,
  ContentDelta,
  ContentCompleted,
  ContentFact,
  ContentProgress,
} from "#protocol/session-events/families/content.js";

export type {
  ContextKind,
  ContextStartedData,
  ContextOutcome,
  ContextSettledData,
  ContextStarted,
  ContextSettled,
  ContextFact,
} from "#protocol/session-events/families/context.js";

export type {
  DeliverySource,
  DeliveryAdmittedData,
  DeliveryConsumedData,
  DeliveryOutcome,
  DeliverySettledData,
  DeliveryAdmitted,
  DeliveryConsumed,
  DeliverySettled,
  DeliveryFact,
} from "#protocol/session-events/families/delivery.js";

export type {
  InteractionSubject,
  InteractionKind,
  InteractionDisplay,
  InteractionOptionStyle,
  InteractionOption,
  InteractionRequest,
  SignInChallenge,
  InteractionOrigin,
  InteractionOpenedData,
  InteractionOutcome,
  InteractionSettledData,
  InteractionOpened,
  InteractionSettled,
  InteractionFact,
} from "#protocol/session-events/families/interaction.js";

export type {
  ModelOwner,
  ModelRequestedData,
  ModelStartedData,
  ModelRetriedData,
  ModelOutcome,
  ModelSettledData,
  ModelRequested,
  ModelStarted,
  ModelRetried,
  ModelSettled,
  ModelFact,
} from "#protocol/session-events/families/model.js";

export type {
  ResponseValue,
  Answer,
  ResponseSubmittedData,
  ResponseAdmittedData,
  ResponseOutcome,
  ResponseSettledData,
  ResponseSubmitted,
  ResponseAdmitted,
  ResponseSettled,
  ResponseFact,
} from "#protocol/session-events/families/response.js";

export type {
  RuntimeIdentity,
  SessionPredecessor,
  TraceContext,
  SessionStartedData,
  SessionOutcome,
  SessionEndedData,
  SessionStarted,
  SessionEnded,
  SessionFact,
} from "#protocol/session-events/families/session.js";

export type {
  TaskStartedData,
  TaskOutcome,
  TaskEndedData,
  TaskStarted,
  TaskEnded,
  TaskFact,
} from "#protocol/session-events/families/task.js";

export type {
  TurnStartedData,
  TurnPausedData,
  TurnOutcome,
  TurnSettledData,
  TurnStarted,
  TurnSettled,
  TurnPaused,
  TurnFact,
} from "#protocol/session-events/families/turn.js";

export type {
  UsageOwner,
  UsageRecordedData,
  UsageRecorded,
  UsageFact,
} from "#protocol/session-events/families/usage.js";

export {
  emptySessionView,
  emptyPreviews,
  foldEvents,
  type ReceivedEvent,
} from "#protocol/session-projection/fold.js";

export {
  activeTurn,
  activity,
  callLabel,
  callState,
  type CallState,
  callOutputSource,
  conversation,
  failure,
  idle,
  openInteractions,
  queue,
  reply,
  tasks,
  waiting,
  type Activity,
  type Waiting,
} from "#protocol/session-projection/selectors.js";
export { requestStatus, type RequestStatus } from "#protocol/session-projection/request-status.js";

export type {
  Introduced,
  Ended,
  SessionRow,
  DeliveryRow,
  TurnRow,
  RunRow,
  PartRow,
  CallRow,
  TaskRow,
  InteractionRow,
  ResponseRow,
  ChildRow,
  ChangeRow,
  UsageTotals,
  SessionView,
  SessionPreviews,
  PartPreview,
  CallPreview,
} from "#protocol/session-projection/tables.js";

export { interaction, signInEnding, type Interaction } from "#protocol/session-reader.js";

export { APPROVE_OPTION_ID, DENY_OPTION_ID } from "#protocol/interaction-options.js";
