// The runtime catalog: every fact and progress type, what family it belongs to, its role in that
// family's lifecycle, and the closed outcome sets. Plain data with no dependencies, so the client
// fold, the checker, and hooks share it without loading schemas.

import type { CallOutcome } from "./families/call.js";
import type { ContextOutcome } from "./families/context.js";
import type { DeliveryOutcome } from "./families/delivery.js";
import type { InteractionOutcome } from "./families/interaction.js";
import type { ModelOutcome } from "./families/model.js";
import type { ResponseOutcome } from "./families/response.js";
import type { SessionOutcome } from "./families/session.js";
import type { TaskOutcome } from "./families/task.js";
import type { TurnOutcome } from "./families/turn.js";
import type { Fact, Progress } from "./facts.js";

/** The stream version this catalog describes. Readers refuse other majors. */
export const STREAM_VERSION = "27";

export type Family =
  | "session"
  | "delivery"
  | "turn"
  | "model"
  | "content"
  | "call"
  | "task"
  | "interaction"
  | "response"
  | "child"
  | "context"
  | "usage";

/**
 * A fact's role in its family's lifecycle: it introduces an entity, updates an open one, ends it,
 * introduces and ends it at once (a content part), or records something with no lifecycle.
 */
export type FactRole = "introduces" | "updates" | "terminal" | "complete" | "record";

export interface FactDescriptor {
  readonly family: Family;
  readonly role: FactRole;
  /** The payload field that names the entity the fact is about. */
  readonly idField: string;
}

export const SESSION_OUTCOMES = [
  "completed",
  "failed",
] as const satisfies readonly SessionOutcome[];
export const DELIVERY_OUTCOMES = [
  "handled",
  "awaiting-input",
  "applied",
  "ignored",
  "refused",
  "failed",
] as const satisfies readonly DeliveryOutcome[];
export const TURN_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TurnOutcome[];
export const MODEL_OUTCOMES = [
  "completed",
  "failed",
  "interrupted",
  "abandoned",
] as const satisfies readonly ModelOutcome[];
export const CALL_OUTCOMES = [
  "completed",
  "failed",
  "rejected",
  "interrupted",
  "abandoned",
] as const satisfies readonly CallOutcome[];
export const TASK_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TaskOutcome[];
export const INTERACTION_OUTCOMES = [
  "accepted",
  "declined",
  "invalid",
  "failed",
  "withdrawn",
  "interrupted",
  "abandoned",
  "expired",
] as const satisfies readonly InteractionOutcome[];
export const RESPONSE_OUTCOMES = [
  "applied",
  "refused",
  "failed",
  "withdrawn",
  "abandoned",
  "expired",
] as const satisfies readonly ResponseOutcome[];
export const CONTEXT_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly ContextOutcome[];

type TerminalType = Extract<Fact["type"], `${string}.${"ended" | "settled"}`>;

/** Each terminal's closed outcome set. A value outside it is a contract violation. */
export const TERMINAL_OUTCOMES: { readonly [TType in TerminalType]: readonly string[] } = {
  "call.settled": CALL_OUTCOMES,
  "context.settled": CONTEXT_OUTCOMES,
  "delivery.settled": DELIVERY_OUTCOMES,
  "interaction.settled": INTERACTION_OUTCOMES,
  "model.settled": MODEL_OUTCOMES,
  "response.settled": RESPONSE_OUTCOMES,
  "session.ended": SESSION_OUTCOMES,
  "task.ended": TASK_OUTCOMES,
  "turn.settled": TURN_OUTCOMES,
};

export const FACT_CATALOG: { readonly [TType in Fact["type"]]: FactDescriptor } = {
  "call.requested": { family: "call", idField: "callId", role: "introduces" },
  "call.settled": { family: "call", idField: "callId", role: "terminal" },
  "call.started": { family: "call", idField: "callId", role: "updates" },
  "child.opened": { family: "child", idField: "sessionId", role: "introduces" },
  "content.completed": { family: "content", idField: "partId", role: "complete" },
  "context.settled": { family: "context", idField: "changeId", role: "terminal" },
  "context.started": { family: "context", idField: "changeId", role: "introduces" },
  "delivery.admitted": { family: "delivery", idField: "deliveryId", role: "introduces" },
  "delivery.consumed": { family: "delivery", idField: "deliveryId", role: "updates" },
  "delivery.settled": { family: "delivery", idField: "deliveryId", role: "terminal" },
  "interaction.opened": { family: "interaction", idField: "interactionId", role: "introduces" },
  "interaction.settled": { family: "interaction", idField: "interactionId", role: "terminal" },
  "model.requested": { family: "model", idField: "runId", role: "introduces" },
  "model.settled": { family: "model", idField: "runId", role: "terminal" },
  "model.started": { family: "model", idField: "runId", role: "updates" },
  "response.admitted": { family: "response", idField: "responseId", role: "updates" },
  "response.settled": { family: "response", idField: "responseId", role: "terminal" },
  "response.submitted": { family: "response", idField: "responseId", role: "introduces" },
  "session.ended": { family: "session", idField: "", role: "terminal" },
  "session.started": { family: "session", idField: "", role: "introduces" },
  "task.ended": { family: "task", idField: "taskId", role: "terminal" },
  "task.started": { family: "task", idField: "taskId", role: "introduces" },
  "turn.paused": { family: "turn", idField: "turnId", role: "updates" },
  "turn.resumed": { family: "turn", idField: "turnId", role: "updates" },
  "turn.settled": { family: "turn", idField: "turnId", role: "terminal" },
  "turn.started": { family: "turn", idField: "turnId", role: "introduces" },
  "usage.recorded": { family: "usage", idField: "", role: "record" },
};

export interface ProgressDescriptor {
  readonly family: Family;
  readonly idField: string;
}

export const PROGRESS_CATALOG: { readonly [TType in Progress["type"]]: ProgressDescriptor } = {
  "call.input": { family: "call", idField: "callId" },
  "call.progress": { family: "call", idField: "callId" },
  "content.delta": { family: "content", idField: "partId" },
};

export type FactType = Fact["type"];
export type ProgressType = Progress["type"];

/** True for a fact type this version knows. Readers ignore the others. */
export function isFactType(type: unknown): type is FactType {
  return typeof type === "string" && Object.hasOwn(FACT_CATALOG, type);
}

/** True for a progress type this version knows. Readers ignore the others. */
export function isProgressType(type: unknown): type is ProgressType {
  return typeof type === "string" && Object.hasOwn(PROGRESS_CATALOG, type);
}

/** True for a terminal fact type. */
export function isTerminalType(type: unknown): type is TerminalType {
  return typeof type === "string" && Object.hasOwn(TERMINAL_OUTCOMES, type);
}

/** True when a terminal's outcome belongs to its closed set. */
export function isKnownOutcome(type: TerminalType, outcome: unknown): boolean {
  return typeof outcome === "string" && TERMINAL_OUTCOMES[type].includes(outcome);
}

/** A content part's phase, with unknown values read as narration. */
export function contentPhase(phase: unknown): "narration" | "reply" {
  return phase === "reply" ? "reply" : "narration";
}
