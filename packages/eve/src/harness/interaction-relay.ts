// What a session relays about its own interactions to the session that serves it: each batch of
// requests it opened, rebuilt with the calls they're about, and the changes the serving session
// can't infer — a sign-in, a settlement only the asker decides, an answer the asker refused.

import type { SubagentAuthorizationEvent, SubagentInputRequestEvent } from "#channel/types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { inputRequestOf } from "#channel/interaction-prompts.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The batch an `interaction.opened` belongs to: every request the same commit opened. Only the
 * first of them relays it, so a batch relays once.
 */
export function openedBatch(
  view: SessionView,
  interactionId: string,
): SubagentInputRequestEvent | undefined {
  const row = view.interactions[interactionId];
  if (row === undefined || row.request.kind === "sign-in") return undefined;
  const batch = Object.values(view.interactions).filter(
    (entry) =>
      entry.status === "open" &&
      entry.introducedAt === row.introducedAt &&
      entry.request.kind !== "sign-in",
  );
  if (batch[0]?.interactionId !== interactionId) return undefined;
  const requests = batch.flatMap((entry) => inputRequestOf(view, entry) ?? []);
  if (requests.length === 0) return undefined;
  const owner = interactionOwner(view, row);
  const turnId = owner.turnId ?? "";
  const event: Mutable<SubagentInputRequestEvent> = {
    requests,
    sequence: Number(/^turn_(\d+)$/.exec(turnId)?.[1] ?? 0),
    stepIndex: 0,
    turnId,
  };
  if (owner.taskId !== undefined) event.taskId = owner.taskId;
  return event;
}

/** Whether the serving session needs to hear how this session settled one of its interactions. */
export function relaysSettlement(row: InteractionRow | undefined, outcome: string): boolean {
  if (row === undefined) return false;
  // The serving session decides a question or budget prompt when it forwards the answer, but
  // only the asker decides an approval or a sign-in, or ends a request early.
  return (
    row.request.kind === "approval" ||
    row.request.kind === "sign-in" ||
    (outcome !== "accepted" && outcome !== "declined" && outcome !== "invalid")
  );
}

/** What this session relays for one of its own facts, if anything. */
export function relayedInteractionEvent(
  view: SessionView,
  event: SessionEvent,
): SubagentAuthorizationEvent | undefined {
  switch (event.type) {
    case "interaction.opened":
      return event.data.request.kind === "sign-in"
        ? { data: event.data, type: "interaction.opened" }
        : undefined;
    case "interaction.settled":
      return relaysSettlement(view.interactions[event.data.interactionId], event.data.outcome)
        ? { data: event.data, type: "interaction.settled" }
        : undefined;
    case "response.settled": {
      const { outcome, reason, responseId } = event.data;
      const row = view.responses[responseId];
      if (row === undefined || outcome === "applied") return undefined;
      if (view.interactions[row.interactionId]?.request.kind !== "approval") return undefined;
      const data: {
        interactionId: string;
        deliveryId: string;
        outcome: typeof outcome;
        reason?: string;
      } = { deliveryId: row.deliveryId, interactionId: row.interactionId, outcome };
      if (reason !== undefined) data.reason = reason;
      return { data, type: "response.settled" };
    }
    default:
      return undefined;
  }
}
