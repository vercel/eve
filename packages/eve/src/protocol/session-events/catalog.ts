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

/** The family a fact or progress record belongs to: the `family` part of its `family.verb` type. */
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

/** How a fact type fits the session lifecycle: its family, its role, and the field naming its entity. */
export interface FactDescriptor {
  readonly family: Family;
  readonly role: FactRole;
  /** The payload field that names the entity the fact is about. */
  readonly idField: string;
}

/** Every outcome a `session.ended` fact can carry, as a runtime list of {@link SessionOutcome} values. */
export const SESSION_OUTCOMES = [
  "completed",
  "failed",
] as const satisfies readonly SessionOutcome[];
/** Every outcome a `delivery.settled` fact can carry, as a runtime list of {@link DeliveryOutcome} values. */
export const DELIVERY_OUTCOMES = [
  "handled",
  "awaiting-input",
  "applied",
  "ignored",
  "refused",
  "failed",
] as const satisfies readonly DeliveryOutcome[];
/** Every outcome a `turn.settled` fact can carry, as a runtime list of {@link TurnOutcome} values. */
export const TURN_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TurnOutcome[];
/** Every outcome a `model.settled` fact can carry, as a runtime list of {@link ModelOutcome} values. */
export const MODEL_OUTCOMES = [
  "completed",
  "failed",
  "interrupted",
  "abandoned",
] as const satisfies readonly ModelOutcome[];
/** Every outcome a `call.settled` fact can carry, as a runtime list of {@link CallOutcome} values. */
export const CALL_OUTCOMES = [
  "completed",
  "failed",
  "rejected",
  "interrupted",
  "abandoned",
] as const satisfies readonly CallOutcome[];
/** Every outcome a `task.ended` fact can carry, as a runtime list of {@link TaskOutcome} values. */
export const TASK_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TaskOutcome[];
/** Every outcome an `interaction.settled` fact can carry, as a runtime list of {@link InteractionOutcome} values. */
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
/** Every outcome a `response.settled` fact can carry, as a runtime list of {@link ResponseOutcome} values. */
export const RESPONSE_OUTCOMES = [
  "applied",
  "refused",
  "failed",
  "withdrawn",
  "abandoned",
  "expired",
] as const satisfies readonly ResponseOutcome[];
/** Every outcome a `context.settled` fact can carry, as a runtime list of {@link ContextOutcome} values. */
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

/** Every fact type the session stream records, mapped to its {@link FactDescriptor}. */
export const FACT_CATALOG: { readonly [TType in Fact["type"]]: FactDescriptor } = {
  "call.requested": { family: "call", idField: "callId", role: "introduces" },
  "call.settled": { family: "call", idField: "callId", role: "terminal" },
  "call.started": { family: "call", idField: "callId", role: "updates" },
  "child.opened": { family: "child", idField: "sessionId", role: "introduces" },
  "child.sent": { family: "child", idField: "sessionId", role: "record" },
  "content.completed": { family: "content", idField: "partId", role: "complete" },
  "context.settled": { family: "context", idField: "changeId", role: "terminal" },
  "context.started": { family: "context", idField: "changeId", role: "introduces" },
  "delivery.admitted": { family: "delivery", idField: "deliveryId", role: "introduces" },
  "delivery.consumed": { family: "delivery", idField: "deliveryId", role: "updates" },
  "delivery.settled": { family: "delivery", idField: "deliveryId", role: "terminal" },
  "interaction.opened": { family: "interaction", idField: "interactionId", role: "introduces" },
  "interaction.settled": { family: "interaction", idField: "interactionId", role: "terminal" },
  "model.requested": { family: "model", idField: "runId", role: "introduces" },
  "model.retried": { family: "model", idField: "runId", role: "updates" },
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
  "turn.settled": { family: "turn", idField: "turnId", role: "terminal" },
  "turn.started": { family: "turn", idField: "turnId", role: "introduces" },
  "usage.recorded": { family: "usage", idField: "", role: "record" },
};

/** How a progress record type maps to its family and the field naming the entity it previews. */
export interface ProgressDescriptor {
  readonly family: Family;
  readonly idField: string;
}

export const PROGRESS_CATALOG: { readonly [TType in Progress["type"]]: ProgressDescriptor } = {
  "call.input": { family: "call", idField: "callId" },
  "call.progress": { family: "call", idField: "callId" },
  "content.delta": { family: "content", idField: "partId" },
};

/** The `type` of any fact the session stream records, such as `turn.started`. */
export type FactType = Fact["type"];
/** The `type` of any progress record, such as `content.delta`. */
export type ProgressType = Progress["type"];

export function isFactType(type: unknown): type is FactType {
  return typeof type === "string" && Object.hasOwn(FACT_CATALOG, type);
}

export function isProgressType(type: unknown): type is ProgressType {
  return typeof type === "string" && Object.hasOwn(PROGRESS_CATALOG, type);
}

export function isTerminalType(type: unknown): type is TerminalType {
  return typeof type === "string" && Object.hasOwn(TERMINAL_OUTCOMES, type);
}

export function isKnownOutcome(type: TerminalType, outcome: unknown): boolean {
  return typeof outcome === "string" && TERMINAL_OUTCOMES[type].includes(outcome);
}

export function contentPhase(phase: unknown): "narration" | "reply" {
  return phase === "reply" ? "reply" : "narration";
}
