// What channels render about requests, read from the facts and the line's tables: the batch of
// requests a commit opened, how a request settled, and a responder an approval refused. Sign-ins
// are `sign-in.ts`'s. Built-in channels render these; authored handlers can read the facts directly.

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
  type Interaction,
} from "#protocol/session-reader.js";
import type { Answer } from "#shared/input.js";
import { interactionBatches } from "#protocol/session-projection/selectors.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export { interaction, signInEnding, type Interaction } from "#protocol/session-reader.js";

/** One commit's requests: what a person is asked at once. */
export interface RequestBatch {
  readonly requests: readonly Interaction[];
  readonly turnId: string;
  /** The task whose run asks. */
  readonly taskId?: string;
  /** The call a relayed request serves. */
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

/** An answer a check or policy refused, for telling its responder privately. */
export interface RefusedAnswer {
  readonly interactionId: string;
  readonly outcome: "refused" | "failed";
  readonly reason?: string;
  readonly responder?: Principal;
}

/**
 * The batch an `interaction.opened` begins: every request its commit opened. The batch's other
 * facts return `undefined`, so a channel renders it once.
 */
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

/**
 * The request a typed reply answers: the first open one. A budget prompt comes first, since the
 * session settles it before anything else; the rest follow the order they opened. Channels that
 * can only show text show this request alone, so a reply answers the request the person sees.
 */
export function firstOpenRequest(view: SessionView): Interaction | undefined {
  const first = promptQueueHead(view);
  return first === undefined ? undefined : interaction(view, first.interactionId);
}

/** How a request ended, from its `interaction.settled`. */
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

/** An answer a check or policy refused, from its `response.settled`. */
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

/** Who gave an answer: the principal of the delivery it arrived in. */
export function responderOf(view: SessionView, responseId: string): Principal | undefined {
  const response = view.responses[responseId];
  return response === undefined ? undefined : view.deliveries[response.deliveryId]?.principal;
}

/** An option's style a channel can render: a style a newer eve added reads as none. */
export function optionStyle(option: {
  readonly style?: string;
}): "primary" | "danger" | "default" | undefined {
  const { style } = option;
  return style === "primary" || style === "danger" || style === "default" ? style : undefined;
}
