/**
 * The session event contract: the catalog of facts and progress records a session stream
 * carries, the shared fold that turns them into tables, and the selectors and guards that hooks,
 * channels, and clients read them with. No runtime dependencies.
 *
 * @packageDocumentation
 */

export {
  STREAM_VERSION,
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
  recordsOf,
  type Cause,
  type CauseKind,
  causeKind,
  type Principal,
  type ErrorInfo,
  type Usage,
  type ValueReference,
  type JsonValue,
  type UserPart,
} from "#protocol/session-events/envelope.js";

export {
  isKnownFact,
  isTerminal,
  familyOf,
  isCompleted,
  hasOutcome,
  hasKind,
  kindOf,
  isCompaction,
} from "#protocol/session-events/guards.js";

export {
  type Fact,
  type Progress,
  type FactOf,
  type ProgressOf,
  type SessionLine,
  type SessionCommit,
  type SessionProgress,
} from "#protocol/session-events/facts.js";

export {
  type CallOwner,
  type CapabilityKind,
  type Capability,
  type CallInputData,
  type CallRequestedData,
  type ClearedBy,
  type CallStartedData,
  type CallProgressData,
  type CallOutcome,
  type CallSettledData,
  type CallInput,
  type CallRequested,
  type CallStarted,
  type CallProgress,
  type CallSettled,
  type CallFact,
  type CallProgressRecord,
} from "#protocol/session-events/families/call.js";

export {
  type ChildOpenedData,
  type ChildOpened,
  type ChildFact,
} from "#protocol/session-events/families/child.js";

export {
  type ContentKind,
  type ContentPhase,
  type ContentDeltaData,
  type ContentCompletedData,
  type ContentDelta,
  type ContentCompleted,
  type ContentFact,
  type ContentProgress,
} from "#protocol/session-events/families/content.js";

export {
  type ContextKind,
  type ContextStartedData,
  type ContextOutcome,
  type ContextSettledData,
  type ContextStarted,
  type ContextSettled,
  type ContextFact,
} from "#protocol/session-events/families/context.js";

export {
  type DeliverySource,
  type DeliveryAdmittedData,
  type DeliveryConsumedData,
  type DeliveryOutcome,
  type DeliverySettledData,
  type DeliveryAdmitted,
  type DeliveryConsumed,
  type DeliverySettled,
  type DeliveryFact,
} from "#protocol/session-events/families/delivery.js";

export {
  type InteractionSubject,
  type InteractionKind,
  type InteractionDisplay,
  type InteractionOptionStyle,
  type InteractionOption,
  type InteractionRequest,
  type SignInChallenge,
  type InteractionOrigin,
  type InteractionOpenedData,
  type InteractionOutcome,
  type InteractionSettledData,
  type InteractionOpened,
  type InteractionSettled,
  type InteractionFact,
} from "#protocol/session-events/families/interaction.js";

export {
  type ModelOwner,
  type ModelRequestedData,
  type ModelStartedData,
  type ModelRetriedData,
  type ModelOutcome,
  type ModelSettledData,
  type ModelRequested,
  type ModelStarted,
  type ModelRetried,
  type ModelSettled,
  type ModelFact,
} from "#protocol/session-events/families/model.js";

export {
  type ResponseValue,
  type Answer,
  type ResponseSubmittedData,
  type ResponseAdmittedData,
  type ResponseOutcome,
  type ResponseSettledData,
  type ResponseSubmitted,
  type ResponseAdmitted,
  type ResponseSettled,
  type ResponseFact,
} from "#protocol/session-events/families/response.js";

export {
  type RuntimeIdentity,
  type TraceContext,
  type SessionStartedData,
  type SessionOutcome,
  type SessionEndedData,
  type SessionStarted,
  type SessionEnded,
  type SessionFact,
} from "#protocol/session-events/families/session.js";

export {
  type TaskStartedData,
  type TaskOutcome,
  type TaskEndedData,
  type TaskStarted,
  type TaskEnded,
  type TaskFact,
} from "#protocol/session-events/families/task.js";

export {
  type TurnStartedData,
  type TurnPausedData,
  type TurnOutcome,
  type TurnSettledData,
  type TurnStarted,
  type TurnSettled,
  type TurnPaused,
  type TurnFact,
} from "#protocol/session-events/families/turn.js";

export {
  type UsageOwner,
  type UsageRecordedData,
  type UsageRecorded,
  type UsageFact,
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
