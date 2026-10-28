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
  readonly runId?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly input?: JsonValue;
  readonly inputRef?: ValueReference;
  readonly output?: JsonValue;
  readonly outputRef?: ValueReference;
  readonly outcome?: CallOutcome;
  readonly reason?: string;
  readonly clearedBy?: ClearedBy;
  readonly usage?: Usage;
} & (
    | { readonly state: "failed"; readonly error: ErrorInfo }
    | { readonly state: Exclude<CallState, "failed">; readonly error?: ErrorInfo }
  );

export interface CallFilter {
  readonly kind?: CapabilityKind;
  readonly name?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly taskId?: string;
}

export interface TurnObservation extends ObservationTiming {
  readonly turnId: string;
  readonly status: "running" | "settled";
  readonly outcome?: TurnOutcome;
  readonly error?: ErrorInfo;
}

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

export interface ContentObservation extends ObservationTiming {
  readonly partId: string;
  readonly runId: string;
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

export interface SessionObservation extends ObservationTiming {
  readonly status: "new" | "open" | "ended";
  readonly outcome?: SessionOutcome;
  readonly error?: ErrorInfo;
  readonly runtime?: RuntimeIdentity;
  readonly parent?: { readonly sessionId: string; readonly callId: string };
}

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

export interface ContentPreviewObservation {
  readonly partId: string;
  readonly runId?: string;
  readonly kind: string;
  readonly text: string;
}

export type Waiting =
  | { readonly on: "session" }
  | { readonly on: "interaction"; readonly interactions: readonly Interaction[] }
  | {
      readonly on: "work";
      readonly calls: readonly CallObservation[];
      readonly tasks: readonly TaskObservation[];
    };

export type Activity =
  | { readonly kind: "idle" | "thinking" | "compacting" }
  | { readonly kind: "calling"; readonly names: readonly string[] }
  | { readonly kind: "waiting-on-interaction"; readonly interactions: readonly Interaction[] }
  | { readonly kind: "waiting-on-tasks"; readonly tasks: readonly TaskObservation[] };
