// Facts as eve writes them. `fact` builds any fact, omitting the fields its data leaves
// undefined; the rest are the lifecycle facts more than one writer makes: a session's start and
// end, a turn's end, a model run's request, start, and settlement with its spend, a context
// change's start, and a control delivery's admission and settlement. Calls' facts are in
// `call-facts.ts`, interactions' and responses' in `interaction-facts.ts`.

import type { SessionEvent } from "#protocol/session-event.js";
import type { Cause, ErrorInfo, Usage } from "#protocol/session-events/envelope.js";
import type { Fact, FactOf } from "#protocol/session-events/facts.js";
import type { DeliveryAdmittedData } from "#protocol/session-events/families/delivery.js";
import type { ModelOwner } from "#protocol/session-events/families/model.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { activeTurn } from "#protocol/session-projection/selectors.js";
import type { ControlDelivery } from "#harness/types.js";
import type { JsonObject } from "#shared/json.js";

/** `value` without the fields it leaves undefined. */
export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/** A fact of `type`, without the fields its data leaves undefined. */
export function fact<T extends Fact["type"]>(type: T, data: FactOf<T>["data"]): FactOf<T> {
  return { data: defined(data as object), type } as FactOf<T>;
}

/** Spend as `usage.recorded` carries it: every count, zero when unreported, and a known cost. */
export function usageOf(counts: Partial<Usage>): Usage {
  return defined({
    cacheReadTokens: counts.cacheReadTokens ?? 0,
    cacheWriteTokens: counts.cacheWriteTokens ?? 0,
    costUsd: counts.costUsd,
    inputTokens: counts.inputTokens ?? 0,
    outputTokens: counts.outputTokens ?? 0,
  });
}

/** A failure as the stream reports it: its code and message, with its support id and remedy. */
export function errorInfoOf(failure: {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
}): ErrorInfo {
  const { errorId, hint } = failure.details ?? {};
  return defined({
    code: failure.code,
    hint: typeof hint === "string" && hint.trim().length > 0 ? hint.trim() : undefined,
    id: typeof errorId === "string" ? errorId : undefined,
    message: failure.message,
  });
}

// ---------------------------------------------------------------------------
// Sessions and turns
// ---------------------------------------------------------------------------

/**
 * The facts that end a session, in one commit, `session.ended` last. The writer closes what the
 * session leaves open before it (`cascade`): an open turn ends cancelled, since its session ended,
 * not it; `failure(view, turnId)` reads the session's error. Every reader stops there.
 */
export function sessionEndedFacts(
  projection: SessionProjection | undefined,
  ending: {
    readonly outcome: "completed" | "failed";
    readonly cause?: Cause;
    /** The reset control that ends the session: admitted first, applied before the end. */
    readonly control?: ControlDelivery;
    readonly error?: ErrorInfo;
  },
): SessionEvent[] {
  const facts: SessionEvent[] = [];
  // A session that ends before it started, as one that fails admitting its first message or a
  // prewarmed one that expires, starts in the same commit: only a started session ends.
  if (projection !== undefined && projection.view.session.status === "new") {
    facts.push(fact("session.started", {}));
  }
  const { control } = ending;
  if (control !== undefined) {
    facts.push(controlAdmitted(control, "reset"), deliveryApplied(control.deliveryId));
  }
  const cause = control === undefined ? ending.cause : { deliveryId: control.deliveryId };
  facts.push(fact("session.ended", { cause, error: ending.error, outcome: ending.outcome }));
  return facts;
}

/** How a turn ends. */
export interface TurnEnding {
  readonly outcome: FactOf<"turn.settled">["data"]["outcome"];
  readonly cause?: Cause;
  readonly error?: ErrorInfo;
}

/**
 * The fact that ends a turn, the open one unless `turnId` names another, with what it replied.
 * The writer closes what it leaves open before it, and settles the deliveries it answered after
 * it (`cascade`).
 */
export function turnSettled(
  projection: SessionProjection,
  ending: TurnEnding,
  turnId = activeTurn(projection.view)?.turnId,
): SessionEvent[] {
  if (turnId === undefined) return [];
  const reply = projection.view.turns[turnId]?.reply;
  return [
    fact("turn.settled", {
      ...ending,
      reply: reply !== undefined && reply.length > 0 ? reply : undefined,
      turnId,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Model runs
// ---------------------------------------------------------------------------

/** A model run is asked for: a turn's, or a context change's summary run. */
export function runRequested(owner: ModelOwner, runId: string): SessionEvent {
  return fact("model.requested", { owner, runId });
}

/** The run's model was chosen and an attempt at its provider call begins. */
export function runStarted(input: {
  readonly runId: string;
  readonly modelId: string;
  readonly attempt: number;
}): SessionEvent {
  const { attempt, modelId, runId } = input;
  return fact("model.started", { attempt, modelId, runId });
}

/** How a run ended, and what it spent. */
export interface RunSettlement {
  readonly runId: string;
  readonly outcome: FactOf<"model.settled">["data"]["outcome"];
  readonly finishReason?: string;
  readonly generationId?: string;
  readonly error?: ErrorInfo;
  readonly usage?: Usage;
}

/** The facts that settle a run: its end, then what it spent. */
export function runSettledFacts(input: RunSettlement): SessionEvent[] {
  const { usage, ...settled } = input;
  const facts: SessionEvent[] = [fact("model.settled", settled)];
  if (usage !== undefined) {
    facts.push(fact("usage.recorded", { kind: "model", owner: { runId: input.runId }, usage }));
  }
  return facts;
}

/**
 * What the agent behind a call spent, recorded against the call; without one, spend that arrived
 * after its call settled, which no open entity owns (`delegated-late`).
 */
export function delegatedUsageFact(callId: string | undefined, usage: Usage): SessionEvent {
  const recorded = usageOf(usage);
  return callId === undefined
    ? fact("usage.recorded", { kind: "delegated-late", usage: recorded })
    : fact("usage.recorded", { kind: "model", owner: { callId }, usage: recorded });
}

// ---------------------------------------------------------------------------
// Context changes and controls
// ---------------------------------------------------------------------------

/** A context change starts. */
export function contextStarted(data: FactOf<"context.started">["data"]): SessionEvent {
  return fact("context.started", data);
}

/** A control's admission: the delivery it arrived as, its kind, and who sent it. */
export function controlAdmitted(delivery: ControlDelivery, control: string): SessionEvent {
  const data: DeliveryAdmittedData = {
    deliveryId: delivery.deliveryId,
    principal: delivery.principal,
    source: { control },
  };
  return fact("delivery.admitted", data);
}

/** A control or callback delivery's settlement once what it asked has happened. */
export function deliveryApplied(deliveryId: string): SessionEvent {
  return fact("delivery.settled", { deliveryId, outcome: "applied" });
}
