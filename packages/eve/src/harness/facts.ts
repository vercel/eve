import type { SessionEvent } from "#protocol/session-event.js";
import type { Cause, ErrorInfo, Usage } from "#protocol/session-events/envelope.js";
import type { Fact, FactOf } from "#protocol/session-events/facts.js";
import type { DeliveryAdmittedData } from "#protocol/session-events/families/delivery.js";
import type { ModelOwner } from "#protocol/session-events/families/model.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { activeTurn } from "#protocol/session-projection/selectors.js";
import type { ControlDelivery } from "#harness/types.js";
import type { JsonObject } from "#shared/json.js";

export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

export function fact<T extends Fact["type"]>(type: T, data: FactOf<T>["data"]): FactOf<T> {
  return { data: defined(data as object), type } as FactOf<T>;
}

export function usageOf(counts: Partial<Usage>): Usage {
  return defined({
    cacheReadTokens: counts.cacheReadTokens ?? 0,
    cacheWriteTokens: counts.cacheWriteTokens ?? 0,
    costUsd: counts.costUsd,
    inputTokens: counts.inputTokens ?? 0,
    outputTokens: counts.outputTokens ?? 0,
  });
}

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

export function sessionEndedFacts(
  projection: Pick<SessionProjection, "view"> | undefined,
  ending: {
    readonly outcome: "completed" | "failed";
    readonly cause?: Cause;
    readonly control?: ControlDelivery;
    readonly settles?: readonly ControlSettlement[];
    readonly error?: ErrorInfo;
  },
): SessionEvent[] {
  const facts: SessionEvent[] = [];
  if (projection !== undefined && projection.view.session.status === "new") {
    facts.push(fact("session.started", {}));
  }
  for (const settlement of ending.settles ?? []) facts.push(...controlSettled(settlement));
  const { control } = ending;
  if (control !== undefined) {
    facts.push(controlAdmitted(control, "reset"), deliveryApplied(control.deliveryId));
  }
  const cause = control === undefined ? ending.cause : { deliveryId: control.deliveryId };
  facts.push(fact("session.ended", { cause, error: ending.error, outcome: ending.outcome }));
  return facts;
}

export interface TurnEnding {
  readonly outcome: FactOf<"turn.settled">["data"]["outcome"];
  readonly cause?: Cause;
  readonly error?: ErrorInfo;
}

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

export function runRequested(owner: ModelOwner, runId: string): SessionEvent {
  return fact("model.requested", { owner, runId });
}

export function runStarted(input: {
  readonly runId: string;
  readonly modelId: string;
  readonly attempt: number;
}): SessionEvent {
  const { attempt, modelId, runId } = input;
  return fact("model.started", { attempt, modelId, runId });
}

export interface RunSettlement {
  readonly runId: string;
  readonly outcome: FactOf<"model.settled">["data"]["outcome"];
  readonly finishReason?: string;
  readonly generationId?: string;
  readonly error?: ErrorInfo;
  readonly usage?: Usage;
}

export function runSettledFacts(input: RunSettlement): SessionEvent[] {
  const { usage, ...settled } = input;
  const facts: SessionEvent[] = [fact("model.settled", settled)];
  if (usage !== undefined) {
    facts.push(fact("usage.recorded", { kind: "model", owner: { runId: input.runId }, usage }));
  }
  return facts;
}

export function delegatedUsageFact(callId: string | undefined, usage: Usage): SessionEvent {
  const recorded = usageOf(usage);
  return callId === undefined
    ? fact("usage.recorded", { kind: "delegated-late", usage: recorded })
    : fact("usage.recorded", { kind: "model", owner: { callId }, usage: recorded });
}

export function contextStarted(data: FactOf<"context.started">["data"]): SessionEvent {
  return fact("context.started", data);
}

export function controlAdmitted(delivery: ControlDelivery, control: string): SessionEvent {
  const data: DeliveryAdmittedData = {
    deliveryId: delivery.deliveryId,
    principal: delivery.principal,
    source: { control },
  };
  return fact("delivery.admitted", data);
}

export interface ControlSettlement {
  readonly control: ControlDelivery;
  readonly source: string;
  readonly outcome: "ignored" | "applied" | "failed";
  readonly reason?: string;
}

export function controlSettled(settlement: ControlSettlement): SessionEvent[] {
  const { control, outcome, reason, source } = settlement;
  return [
    controlAdmitted(control, source),
    fact("delivery.settled", {
      deliveryId: control.deliveryId,
      outcome,
      ...(reason !== undefined && { reason }),
    }),
  ];
}

export function deliveryApplied(deliveryId: string): SessionEvent {
  return fact("delivery.settled", { deliveryId, outcome: "applied" });
}
