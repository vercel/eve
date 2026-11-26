import type {
  ErrorInfo,
  JsonValue,
  Principal,
  Usage,
  UserPart,
  ValueReference,
} from "#protocol/session-events/envelope.js";
import type {
  CapabilityKind,
  CallOutcome,
  ClearedBy,
} from "#protocol/session-events/families/call.js";
import type {
  DeliveryOutcome,
  DeliverySource,
} from "#protocol/session-events/families/delivery.js";
import type { TurnOutcome } from "#protocol/session-events/families/turn.js";
import type { TaskOutcome } from "#protocol/session-events/families/task.js";
import type { ModelOutcome } from "#protocol/session-events/families/model.js";
import type { ContentKind, ContentPhase } from "#protocol/session-events/families/content.js";
import type { RuntimeIdentity, SessionOutcome } from "#protocol/session-events/families/session.js";
import type { Interaction } from "#protocol/session-projection/reader.js";
import type { CallState } from "./selectors.js";

/** Wall-clock times reported by the facts, not storage positions. */
export interface ObservationTiming {
  readonly startedAt?: string;
  readonly endedAt?: string;
}

/** Display-ready call state and resolved ownership; no table joins are required. */
export type CallObservation = ObservationTiming & {
  readonly callId: string;
  readonly name: string;
  readonly kind: CapabilityKind;
  readonly label: string;
  /** Its tool set `label: false`, so readers showing activity leave it out. */
  readonly hidden?: true;
  /**
   * The call this call runs inside, such as a `workflow()` program call. Absent for a call the
   * model made itself.
   */
  readonly parentCallId?: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly input?: JsonValue;
  readonly inputRef?: ValueReference;
  readonly output?: JsonValue;
  readonly outputRef?: ValueReference;
  /** Estimated tokens of the input the model sent. */
  readonly inputTokens?: number;
  /** Estimated tokens of the output or error the model received. */
  readonly outputTokens?: number;
  readonly outcome?: CallOutcome;
  readonly reason?: string;
  readonly clearedBy?: ClearedBy;
  readonly usage?: Usage;
} & (
    | { readonly state: "failed"; readonly error: ErrorInfo }
    | { readonly state: Exclude<CallState, "failed">; readonly error?: ErrorInfo }
  );

/** Criteria for {@link calls}; every field given must match, and omitted fields match any call. */
export interface CallFilter {
  readonly kind?: CapabilityKind;
  readonly name?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly taskId?: string;
}

/** A turn of the session: whether it is still running or has settled, and how it ended. */
export interface TurnObservation extends ObservationTiming {
  readonly turnId: string;
  readonly status: "running" | "settled";
  readonly outcome?: TurnOutcome;
  readonly error?: ErrorInfo;
}

/**
 * A message delivered to the session, from admission through being consumed by a turn to settling,
 * with its sender and parts when known.
 */
export interface DeliveryObservation extends ObservationTiming {
  readonly deliveryId: string;
  readonly status: "admitted" | "consumed" | "settled";
  readonly turnId?: string;
  readonly outcome?: DeliveryOutcome;
  readonly reason?: string;
  readonly source?: DeliverySource;
  readonly principal?: Principal;
  readonly parts?: readonly UserPart[];
}

/** A background task started by a call, with whether it is still running and how it ended. */
export interface TaskObservation extends ObservationTiming {
  readonly taskId: string;
  readonly callId: string;
  readonly name: string;
  readonly kind: string;
  readonly status: "running" | "ended";
  readonly outcome?: TaskOutcome;
  readonly reason?: string;
  readonly error?: ErrorInfo;
}

/** One model run, with its model, status, finish reason, and token usage. */
export interface RunObservation extends ObservationTiming {
  readonly runId: string;
  readonly turnId?: string;
  readonly status: "requested" | "running" | "settled";
  readonly modelId?: string;
  readonly outcome?: ModelOutcome;
  readonly finishReason?: string;
  readonly error?: ErrorInfo;
  readonly usage?: Usage;
}

/** A committed content part, such as reply text, written by a model run or a turn. */
export interface ContentObservation extends ObservationTiming {
  readonly partId: string;
  /** The model run that wrote the part; absent when its turn wrote it. */
  readonly runId?: string;
  /** The turn the part belongs to, when known. */
  readonly turnId?: string;
  readonly kind: ContentKind;
  readonly phase: ContentPhase;
  readonly value?: JsonValue;
  readonly valueRef?: ValueReference;
  readonly interrupted?: true;
  readonly mediaType?: string;
  readonly fallbackText?: string;
}

/** A linked agent session, with its owning call resolved when the facts name one. */
export interface ChildObservation {
  readonly sessionId: string;
  readonly name: string;
  readonly callId?: string;
}

/**
 * The session's lifecycle status, outcome, runtime identity, and parent session when it is a child.
 */
export interface SessionObservation extends ObservationTiming {
  readonly status: "new" | "open" | "ended";
  readonly outcome?: SessionOutcome;
  readonly error?: ErrorInfo;
  readonly runtime?: RuntimeIdentity;
  readonly parent?: { readonly sessionId: string; readonly callId: string };
}

/** Token usage accumulated across the session, in total and broken down by kind. */
export interface SessionUsage {
  readonly total: Usage;
  readonly byKind: { readonly [kind: string]: Usage };
}

/** Uncommitted input text and progress, explicitly separate from a call's committed values. */
export interface CallPreviewObservation {
  readonly callId: string;
  readonly input: string;
  readonly output?: JsonValue;
  readonly label?: string;
}

/** Uncommitted text streaming into a content part, separate from the part's committed value. */
export interface ContentPreviewObservation {
  readonly partId: string;
  readonly runId?: string;
  readonly kind: string;
  readonly text: string;
}

/**
 * What an unsettled turn is waiting on: the session itself making progress, open interactions that
 * need an answer, or running calls and tasks.
 */
export type Waiting =
  | { readonly on: "session" }
  | { readonly on: "interaction"; readonly interactions: readonly Interaction[] }
  | {
      readonly on: "work";
      readonly calls: readonly CallObservation[];
      readonly tasks: readonly TaskObservation[];
    };

/**
 * A display summary of what the agent is doing right now: idle, thinking, compacting, calling
 * tools by label, or waiting on interactions or tasks.
 */
export type Activity =
  | { readonly kind: "idle" | "thinking" | "compacting" }
  | { readonly kind: "calling"; readonly names: readonly string[] }
  | { readonly kind: "waiting-on-interaction"; readonly interactions: readonly Interaction[] }
  | { readonly kind: "waiting-on-tasks"; readonly tasks: readonly TaskObservation[] };
