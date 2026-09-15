import type { EveAgentReducerEvent } from "#client/reducer.js";
import type { MessageStreamEvent } from "#protocol/message.js";

export interface PendingMessageSubmission {
  readonly createdAt: number;
  readonly deliveryId?: string;
  readonly id: string;
  readonly message: string;
}

export function bindPendingMessageSubmission(
  submissions: readonly PendingMessageSubmission[],
  submissionId: string,
  deliveryId: string | undefined,
): readonly PendingMessageSubmission[] {
  if (deliveryId === undefined) return submissions;
  return submissions.map((submission) =>
    submission.id === submissionId ? { ...submission, deliveryId } : submission,
  );
}

export function pendingSubmissionsForDeliveryIds(
  submissions: readonly PendingMessageSubmission[],
  deliveryIds: readonly string[] | undefined,
): readonly PendingMessageSubmission[] {
  if (deliveryIds === undefined) {
    const fallback = submissions.find((submission) => submission.deliveryId === undefined);
    return fallback === undefined ? [] : [fallback];
  }

  const identities = new Set(deliveryIds);
  return submissions.filter(
    (submission) => submission.deliveryId !== undefined && identities.has(submission.deliveryId),
  );
}

export function recordReceivedFollowUpDeliveryIds(
  acceptedDeliveryIds: ReadonlySet<string>,
  receivedDeliveryIds: Set<string>,
  deliveryIds: readonly string[] | undefined,
): void {
  const ids =
    deliveryIds ??
    [...acceptedDeliveryIds]
      .filter((deliveryId) => !receivedDeliveryIds.has(deliveryId))
      .slice(0, 1);
  for (const deliveryId of ids) {
    if (acceptedDeliveryIds.has(deliveryId)) receivedDeliveryIds.add(deliveryId);
  }
}

export function settlePendingSubmissions(
  submissions: readonly PendingMessageSubmission[],
  projectionEvents: readonly EveAgentReducerEvent[],
  event: MessageStreamEvent,
): {
  readonly pendingSubmissions: readonly PendingMessageSubmission[];
  readonly projectionEvents: readonly EveAgentReducerEvent[];
} {
  const pendingSubmissions = pendingSubmissionsForDeliveryIds(submissions, event.meta?.deliveryIds);
  if (pendingSubmissions.length === 0) {
    return { pendingSubmissions: submissions, projectionEvents: [...projectionEvents, event] };
  }
  const submissionIds = new Set(pendingSubmissions.map((submission) => submission.id));
  return {
    pendingSubmissions: submissions.filter((submission) => !submissionIds.has(submission.id)),
    projectionEvents: replaceProjectionEvents(
      projectionEvents,
      (candidate) =>
        candidate.type === "client.message.submitted" &&
        submissionIds.has(candidate.data.submissionId),
      event,
    ),
  };
}

export function replaceProjectionEvents(
  events: readonly EveAgentReducerEvent[],
  predicate: (event: EveAgentReducerEvent) => boolean,
  replacement: EveAgentReducerEvent,
): readonly EveAgentReducerEvent[] {
  let replaced = false;
  const next = events.flatMap((event) => {
    if (!predicate(event)) return [event];
    if (replaced) return [];
    replaced = true;
    return [replacement];
  });
  return replaced ? next : [...events, replacement];
}

export function replaceProjectionEvent(
  events: readonly EveAgentReducerEvent[],
  predicate: (event: EveAgentReducerEvent) => boolean,
  replacement: EveAgentReducerEvent,
): readonly EveAgentReducerEvent[] {
  return replaceProjectionEvents(events, predicate, replacement);
}
