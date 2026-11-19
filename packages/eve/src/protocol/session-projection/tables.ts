import type {
  CallOutcome,
  Capability,
  CapabilityKind,
  CallOwner,
  ClearedBy,
} from "#protocol/session-events/families/call.js";
import type { ChildOpenedData } from "#protocol/session-events/families/child.js";
import type { ContentKind, ContentPhase } from "#protocol/session-events/families/content.js";
import type { ContextKind, ContextOutcome } from "#protocol/session-events/families/context.js";
import type {
  DeliveryOutcome,
  DeliverySource,
} from "#protocol/session-events/families/delivery.js";
import type {
  InteractionOpenedData,
  InteractionOutcome,
} from "#protocol/session-events/families/interaction.js";
import type { ModelOutcome, ModelOwner } from "#protocol/session-events/families/model.js";
import type { ResponseOutcome, ResponseValue } from "#protocol/session-events/families/response.js";
import type { RuntimeIdentity, SessionOutcome } from "#protocol/session-events/families/session.js";
import type { TaskOutcome } from "#protocol/session-events/families/task.js";
import type { TurnOutcome } from "#protocol/session-events/families/turn.js";
import type {
  Cause,
  ErrorInfo,
  JsonValue,
  Principal,
  Usage,
  UserPart,
  ValueReference,
} from "#protocol/session-events/envelope.js";

/** Where and when a row's entity was introduced. */
export interface Introduced {
  /** The position of the line that introduced it. */
  readonly introducedAt: number;
  /** The time of that line. */
  readonly startedAt: string;
}

/** When a row's entity ended, once it has. */
export interface Ended {
  /** The position of the line that ended it, comparable with `introducedAt`. */
  readonly closedAt?: number;
  /** The time of that line. */
  readonly endedAt?: string;
}

export interface SessionRow extends Ended {
  readonly status: "new" | "open" | "ended";
  readonly startedAt?: string;
  readonly parent?: { readonly sessionId: string; readonly callId: string };
  readonly runtime?: RuntimeIdentity;
  readonly outcome?: SessionOutcome;
  readonly cause?: Cause;
  readonly error?: ErrorInfo;
  readonly turnCount: number;
  readonly latestTurnId?: string;
}

export interface DeliveryRow extends Introduced, Ended {
  readonly deliveryId: string;
  readonly principal?: Principal;
  readonly source?: DeliverySource;
  readonly status: "admitted" | "consumed" | "settled";
  /** The turn that consumed it, or the turn its settlement points at. */
  readonly turnId?: string;
  /** The position of the line that consumed it. */
  readonly consumedAt?: number;
  readonly parts?: readonly UserPart[];
  readonly outcome?: DeliveryOutcome;
  readonly reason?: string;
}

export interface TurnRow extends Introduced, Ended {
  readonly turnId: string;
  readonly cause: Cause;
  readonly follows: string | null;
  readonly status: "running" | "settled";
  readonly runs?: number;
  readonly reply?: readonly string[];
  readonly outcome?: TurnOutcome;
  readonly error?: ErrorInfo;
  readonly endedBy?: Cause;
}

export interface RunRow extends Introduced, Ended {
  readonly runId: string;
  readonly owner: ModelOwner;
  readonly status: "requested" | "running" | "settled";
  readonly step?: number;
  readonly modelId?: string;
  readonly attempt?: number;
  readonly outcome?: ModelOutcome;
  readonly finishReason?: string;
  readonly generationId?: string;
  readonly error?: ErrorInfo;
  readonly usage?: Usage;
}

export interface PartRow extends Introduced {
  readonly partId: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly kind: ContentKind;
  readonly phase: ContentPhase;
  readonly value?: JsonValue;
  readonly valueRef?: ValueReference;
  readonly interrupted?: true;
  readonly mediaType?: string;
  readonly fallbackText?: string;
}

export interface CallRow extends Introduced, Ended {
  readonly callId: string;
  readonly owner: CallOwner;
  readonly capability: Capability;
  readonly input?: JsonValue;
  readonly inputRef?: ValueReference;
  readonly inputError?: ErrorInfo;
  readonly status: "requested" | "running" | "settled";
  readonly clearedBy?: ClearedBy;
  readonly taskId?: string;
  readonly outcome?: CallOutcome;
  readonly output?: JsonValue;
  readonly outputRef?: ValueReference;
  readonly outputOf?: { readonly callId: string };
  readonly error?: ErrorInfo;
  readonly reason?: string;
  readonly cause?: Cause;
  readonly label?: string;
  readonly usage?: Usage;
}

export interface TaskRow extends Introduced, Ended {
  readonly taskId: string;
  readonly startedBy: { readonly callId: string };
  readonly kind: string;
  readonly name: string;
  readonly status: "running" | "ended";
  readonly outcome?: TaskOutcome;
  readonly reason?: string;
  readonly error?: ErrorInfo;
}

export interface InteractionRow extends Introduced, Ended {
  readonly interactionId: string;
  readonly subject: InteractionOpenedData["subject"];
  readonly request: InteractionOpenedData["request"];
  readonly origin?: InteractionOpenedData["origin"];
  readonly audience?: InteractionOpenedData["audience"];
  readonly status: "open" | "settled";
  readonly outcome?: InteractionOutcome;
  readonly reason?: string;
  readonly cause?: Cause;
  readonly response?: { readonly [key: string]: JsonValue };
}

export interface ResponseRow extends Introduced, Ended {
  readonly responseId: string;
  readonly interactionId: string;
  readonly deliveryId: string;
  readonly value?: ResponseValue;
  readonly status: "submitted" | "admitted" | "settled";
  readonly outcome?: ResponseOutcome;
  readonly reason?: string;
}

export interface ChildRow extends Introduced, ChildOpenedData {
  readonly deliveries?: readonly { readonly deliveryId: string; readonly callId: string }[];
}

export interface ChangeRow extends Introduced, Ended {
  readonly changeId: string;
  readonly kind: ContextKind;
  readonly turnId?: string;
  readonly cause?: Cause;
  readonly trigger?: { readonly inputTokens: number };
  readonly status: "running" | "settled";
  readonly outcome?: ContextOutcome;
  readonly selects?: null | { readonly turnId: string };
  readonly error?: ErrorInfo;
}

export interface UsageTotals {
  readonly total: Usage;
  readonly byKind: { readonly [kind: string]: Usage };
}

type Table<TRow> = { readonly [id: string]: TRow };

export interface SessionView {
  readonly position: number;
  readonly session: SessionRow;
  readonly deliveries: Table<DeliveryRow>;
  readonly turns: Table<TurnRow>;
  readonly runs: Table<RunRow>;
  readonly parts: Table<PartRow>;
  readonly calls: Table<CallRow>;
  readonly tasks: Table<TaskRow>;
  readonly interactions: Table<InteractionRow>;
  readonly responses: Table<ResponseRow>;
  readonly children: Table<ChildRow>;
  readonly changes: Table<ChangeRow>;
  readonly usage: UsageTotals;
  readonly selection?: null | { readonly turnId: string };
}

export interface SessionPreviews {
  readonly parts: Table<PartPreview>;
  readonly calls: Table<CallPreview>;
}

export interface PartPreview {
  readonly partId: string;
  readonly runId?: string;
  readonly kind: string;
  readonly text: string;
}

export interface CallPreview {
  readonly callId: string;
  readonly runId?: string;
  readonly name: string;
  readonly kind?: CapabilityKind;
  readonly input: string;
  readonly output?: JsonValue;
  readonly label?: string;
}
