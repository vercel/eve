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
  type FactType,
  type ProgressType,
} from "#protocol/session-events/catalog.js";

export {
  type Scope,
  type Envelope,
  type FactPosition,
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
  ChildSentData,
  ChildSent,
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
  ImportedMessage,
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
  foldEvents,
  position,
  session,
  turn,
  turns,
  activeTurn,
  conversation,
  call,
  calls,
  callLabel,
  callState,
  callOutputSource,
  callPreview,
  interaction,
  interactions,
  openInteractions,
  delivery,
  deliveries,
  queue,
  task,
  tasks,
  runs,
  part,
  parts,
  reply,
  children,
  contentPreviews,
  usage,
  failure,
  idle,
  waiting,
  activity,
  type SessionView,
  type ReceivedEvent,
  type CallState,
  type RequestStatus,
  type Activity,
  type Waiting,
  type ObservationTiming,
  type CallObservation,
  type CallFilter,
  type TurnObservation,
  type DeliveryObservation,
  type TaskObservation,
  type RunObservation,
  type ContentObservation,
  type ChildObservation,
  type SessionObservation,
  type SessionUsage,
  type CallPreviewObservation,
  type ContentPreviewObservation,
} from "#protocol/session-projection/public-view.js";

export { signInEnding, type Interaction } from "#protocol/session-projection/reader.js";

export { APPROVE_OPTION_ID, DENY_OPTION_ID } from "#protocol/interaction-options.js";

export type { JsonObject, JsonArray, JsonPrimitive } from "#shared/json.js";
