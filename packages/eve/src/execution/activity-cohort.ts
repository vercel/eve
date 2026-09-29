import type { DeliverHookPayload } from "#channel/types.js";
import type { MatchedAuthorizationCallback } from "#execution/authorization-callback-match.js";
import { getPendingAuthorization, type PendingAuthorizationState } from "#harness/authorization.js";
import type { ContextContainer } from "#context/container.js";
import {
  ActivityObserverKey,
  ActivityPendingBlockersKey,
  ActivityRootTurnIdKey,
  ActivityTaskCallsKey,
} from "#context/keys.js";
import { isSessionLimitPromptBatch } from "#harness/hitl/session-limit-input-requests.js";
import {
  activityRequestIdsForRootTurn,
  activityRootTurnIdForInputResponses,
  getPendingInputBatches,
} from "#harness/pending-input-batches.js";
import type { SessionStateMap } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

export function updateActivityRootForDelivery(input: {
  readonly activeTurnId: string;
  readonly ctx: ContextContainer;
  readonly delivery?: DeliverHookPayload;
  readonly sessionState: SessionStateMap | undefined;
}): void {
  if (!input.ctx.has(ActivityObserverKey)) return;
  const delivery = input.delivery;
  if (delivery === undefined) return;
  const hasMessage = delivery.payloads.some((payload) => payload.message !== undefined);
  if (hasMessage) {
    input.ctx.set(ActivityRootTurnIdKey, input.activeTurnId);
    input.ctx.delete(ActivityPendingBlockersKey);
    return;
  }
  const responseIds = new Set(
    delivery.payloads.flatMap((payload) =>
      (payload.inputResponses ?? []).map((response) => response.requestId),
    ),
  );
  if (responseIds.size === 0) return;
  const rootTurnId =
    activityRootTurnIdForInputResponses(input.sessionState, responseIds) ??
    input.ctx.get(ActivityRootTurnIdKey) ??
    input.activeTurnId;
  input.ctx.set(ActivityRootTurnIdKey, rootTurnId);
  input.ctx.set(
    ActivityPendingBlockersKey,
    activityRequestIdsForRootTurn(input.sessionState, rootTurnId),
  );
}

export function restoreAuthorizationActivity(input: {
  readonly ctx: ContextContainer;
  readonly matches: readonly MatchedAuthorizationCallback[];
  readonly pending: PendingAuthorizationState;
}): readonly string[] {
  const ids = input.matches.map((match) => match.result.attemptId);
  const rootTurnId = ids.map((id) => input.pending.activityRootTurnIds?.[id]).find(Boolean);
  if (rootTurnId !== undefined) {
    input.ctx.set(ActivityRootTurnIdKey, rootTurnId);
    input.ctx.set(
      ActivityPendingBlockersKey,
      Object.entries(input.pending.activityRootTurnIds ?? {}).flatMap(([id, candidateRoot]) =>
        candidateRoot === rootTurnId ? [id] : [],
      ),
    );
  }
  clearActivityBlockers(input.ctx, ids);
  return ids;
}

/** Tracks the pending blockers and task calls that activity projection reads. */
export function updateActivityState(
  ctx: ContextContainer,
  event: UnstampedMessageStreamEvent,
): void {
  if (!ctx.has(ActivityObserverKey)) return;
  if (event.type === "task.started") {
    addActivityTaskCall(ctx, event.data.callId);
  } else if (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled"
  ) {
    // Every receipt of the turn's task calls is published before the turn ends.
    ctx.delete(ActivityTaskCallsKey);
  } else if (event.type === "input.requested") {
    addActivityBlockers(
      ctx,
      event.data.requests.map((request) => request.requestId),
    );
  } else if (event.type === "input.resolved") {
    clearActivityBlockers(
      ctx,
      event.data.resolutions.map((resolution) => resolution.requestId),
    );
  } else if (event.type === "authorization.required") {
    addActivityBlockers(ctx, [authorizationBlockerId(event)]);
  } else if (event.type === "authorization.completed") {
    clearActivityBlockers(ctx, [authorizationBlockerId(event)]);
  }
}

/**
 * Keeps only the blockers a cancel leaves answerable: the session's own input
 * requests and sign-ins. The cancel withdraws a session-limit prompt and what
 * a child asked through the session, so those no longer hold its work open.
 */
export function retainAnswerableActivityBlockers(
  ctx: ContextContainer,
  sessionState: SessionStateMap | undefined,
): void {
  const pending = ctx.get(ActivityPendingBlockersKey);
  if (pending === undefined) return;
  const answerable = new Set([
    ...getPendingInputBatches(sessionState).flatMap((batch) =>
      isSessionLimitPromptBatch(batch) ? [] : batch.requests.map((request) => request.requestId),
    ),
    ...(getPendingAuthorization(sessionState)?.challenges ?? []).flatMap(
      (challenge) => challenge.attemptId ?? challenge.candidateId ?? [],
    ),
  ]);
  clearActivityBlockers(
    ctx,
    pending.filter((id) => !answerable.has(id)),
  );
}

export function clearActivityBlockers(ctx: ContextContainer, ids: readonly string[]): void {
  const cleared = new Set(ids);
  const remaining = (ctx.get(ActivityPendingBlockersKey) ?? []).filter((id) => !cleared.has(id));
  if (remaining.length === 0) ctx.delete(ActivityPendingBlockersKey);
  else ctx.set(ActivityPendingBlockersKey, remaining);
}

function addActivityTaskCall(ctx: ContextContainer, callId: string): void {
  ctx.set(ActivityTaskCallsKey, [...(ctx.get(ActivityTaskCallsKey) ?? []), callId]);
}

function addActivityBlockers(ctx: ContextContainer, ids: readonly string[]): void {
  ctx.set(ActivityPendingBlockersKey, [
    ...new Set([...(ctx.get(ActivityPendingBlockersKey) ?? []), ...ids]),
  ]);
}

function authorizationBlockerId(
  event: Extract<
    UnstampedMessageStreamEvent,
    { readonly type: "authorization.required" | "authorization.completed" }
  >,
): string {
  return (
    event.data.attemptId ??
    event.data.candidateId ??
    `${event.data.turnId}:${String(event.data.stepIndex)}:${event.data.name}`
  );
}
