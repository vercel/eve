import type { Principal } from "#protocol/session-events/envelope.js";
import type {
  InteractionOpenedData,
  InteractionOutcome,
  InteractionRequest,
  InteractionSettledData,
} from "#protocol/session-events/families/interaction.js";
import type { ResponseSettledData } from "#protocol/session-events/families/response.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import {
  interaction,
  decidingAnswer,
  promptQueueHead,
  responderOf,
  type Interaction,
} from "#protocol/session-projection/reader.js";
import type { Answer } from "#shared/input.js";
import { interactionBatches } from "#protocol/session-projection/selectors.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export {
  interaction,
  signInEnding,
  type Interaction,
} from "#protocol/session-projection/reader.js";

export interface RequestBatch {
  readonly requests: readonly Interaction[];
  readonly turnId: string;
  readonly taskId?: string;
  readonly callId?: string;
}

/** How a request ended, with the answer that decided it and who gave it. */
export interface RequestSettlement {
  readonly interactionId: string;
  readonly kind: InteractionRequest["kind"];
  readonly outcome: InteractionOutcome;
  readonly reason?: string;
  readonly answer?: Answer;
  /** Who gave the deciding answer, through its delivery. */
  readonly responder?: Principal;
}

export interface RefusedAnswer {
  readonly interactionId: string;
  readonly outcome: "refused" | "failed";
  readonly reason?: string;
  readonly responder?: Principal;
}

export function requestBatchOf(
  view: SessionView,
  data: InteractionOpenedData,
): RequestBatch | undefined {
  const row = view.interactions[data.interactionId];
  const batch = interactionBatches(view).find((entries) => entries[0] === row);
  if (row === undefined || batch === undefined) return undefined;
  const requests = batch.flatMap((entry) => interaction(view, entry.interactionId) ?? []);
  if (requests.length === 0) return undefined;
  const owner = interactionOwner(view, row);
  const result: Mutable<RequestBatch> = { requests, turnId: owner.turnId ?? "" };
  if (owner.taskId !== undefined) result.taskId = owner.taskId;
  if (row.origin !== undefined || row.request.kind === "question") {
    if ("callId" in row.subject) result.callId = row.subject.callId;
  }
  return result;
}

export function firstOpenRequest(view: SessionView): Interaction | undefined {
  const first = promptQueueHead(view);
  return first === undefined ? undefined : interaction(view, first.interactionId);
}

export function requestSettlementOf(
  view: SessionView,
  data: InteractionSettledData,
): RequestSettlement | undefined {
  const row = view.interactions[data.interactionId];
  if (row === undefined || row.request.kind === "sign-in") return undefined;
  const settled: Mutable<RequestSettlement> = {
    interactionId: row.interactionId,
    kind: row.request.kind,
    outcome: data.outcome,
  };
  const answer = decidingAnswer({ ...row, response: data.response });
  if (answer !== undefined) settled.answer = answer;
  if (data.reason !== undefined) settled.reason = data.reason;
  const responder =
    data.cause !== undefined && "responseId" in data.cause
      ? responderOf(view, data.cause.responseId)
      : undefined;
  if (responder !== undefined) settled.responder = responder;
  return settled;
}

export function refusedAnswerOf(
  view: SessionView,
  data: ResponseSettledData,
): RefusedAnswer | undefined {
  if (data.outcome !== "refused" && data.outcome !== "failed") return undefined;
  const row = view.responses[data.responseId];
  if (row === undefined) return undefined;
  const refused: Mutable<RefusedAnswer> = {
    interactionId: row.interactionId,
    outcome: data.outcome,
  };
  if (data.reason !== undefined) refused.reason = data.reason;
  const responder = responderOf(view, data.responseId);
  if (responder !== undefined) refused.responder = responder;
  return refused;
}

export function optionStyle(option: {
  readonly style?: string;
}): "primary" | "danger" | "default" | undefined {
  const { style } = option;
  return style === "primary" || style === "danger" || style === "default" ? style : undefined;
}
