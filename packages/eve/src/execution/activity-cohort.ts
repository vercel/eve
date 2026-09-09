import type { DeliverHookPayload } from "#channel/types.js";
import type { MatchedAuthorizationCallback } from "#execution/authorization-callback-match.js";
import type { PendingAuthorizationState } from "#harness/authorization.js";
import type { ContextContainer } from "#context/container.js";
import {
  ActivityObserverKey,
  ActivityPendingBlockersKey,
  ActivityRootTurnIdKey,
} from "#context/keys.js";
import {
  activityRequestIdsForRootTurn,
  activityRootTurnIdForInputResponses,
} from "#harness/pending-input-batches.js";
import type { SessionStateMap } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

export function updateActivityRootForDelivery(input: {
  readonly activeTurnId: string;
  readonly ctx: ContextContainer;
  readonly delivery?: DeliverHookPayload;
  readonly sessionState: SessionStateMap | undefined;
  readonly taskRootTurnId?: string;
}): void {
  if (!input.ctx.has(ActivityObserverKey)) return;
  if (input.taskRootTurnId !== undefined) {
    input.ctx.set(ActivityRootTurnIdKey, input.taskRootTurnId);
    return;
  }
  const delivery = input.delivery;
  if (delivery === undefined) return;
  const hasMessage = delivery.payloads.some((payload) => payload.message !== undefined);
  if (hasMessage && delivery.taskDeliveryId === undefined) {
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
  const ids = input.matches.map(
    (match) => match.result.attemptId ?? match.candidateId ?? match.result.name,
  );
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

export function updateActivityBlockers(
  ctx: ContextContainer,
  event: UnstampedMessageStreamEvent,
): void {
  if (!ctx.has(ActivityObserverKey)) return;
  if (event.type === "input.requested") {
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

export function clearActivityBlockers(ctx: ContextContainer, ids: readonly string[]): void {
  const cleared = new Set(ids);
  const remaining = (ctx.get(ActivityPendingBlockersKey) ?? []).filter((id) => !cleared.has(id));
  if (remaining.length === 0) ctx.delete(ActivityPendingBlockersKey);
  else ctx.set(ActivityPendingBlockersKey, remaining);
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
