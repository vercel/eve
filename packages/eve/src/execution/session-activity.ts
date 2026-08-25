import { normalizeActivityText } from "#execution/activity-text.js";
import {
  type PendingActivitySettlementV1,
  type ActivityActionPhase,
  type ActivityActionStateV1,
  type ActivityBatchV1,
  type ActivityBlockerPhase,
  type ActivityBlockerStateV1,
  type ActivityEventV1,
  type ActivitySnapshotV1,
  type ActivityWorkPhase,
  type ActivityWorkStateV1,
} from "#protocol/activity.js";

export const MAX_ACTIVITY_EVENT_IDS = 1_000;
export const MAX_ACTIVITY_PENDING_SETTLEMENTS = 500;
export const MAX_ACTIVITY_ENTITIES = 500;

export function createActivitySnapshot(): ActivitySnapshotV1 {
  return {
    actions: {},
    blockers: {},
    pendingSettlements: {},
    revision: 0,
    seenEventIds: [],
    version: 1,
    work: {},
  };
}

export function reduceActivityBatch(
  snapshot: ActivitySnapshotV1,
  batch: ActivityBatchV1,
): ActivitySnapshotV1 {
  let state = snapshot;
  let seenEventIds = snapshot.seenEventIds;
  let presentationChanged = false;
  let accepted = false;

  for (const event of batch.events) {
    if (seenEventIds.includes(event.eventId)) continue;
    const next = reduceEvent(state, event);
    if (next === state) continue;
    accepted = true;
    seenEventIds = appendBounded(seenEventIds, event.eventId, MAX_ACTIVITY_EVENT_IDS);
    presentationChanged ||= presentationDiffers(state, next);
    state = next;
  }

  if (!accepted) return snapshot;
  if (!presentationChanged) return { ...state, revision: snapshot.revision, seenEventIds };
  return { ...state, revision: snapshot.revision + 1, seenEventIds };
}

function presentationDiffers(left: ActivitySnapshotV1, right: ActivitySnapshotV1): boolean {
  return (
    left.actions !== right.actions || left.blockers !== right.blockers || left.work !== right.work
  );
}

function reduceEvent(snapshot: ActivitySnapshotV1, event: ActivityEventV1): ActivitySnapshotV1 {
  switch (event.kind) {
    case "work.started":
      return startWork(snapshot, event);
    case "work.settled":
      return settleWork(snapshot, event);
    case "action.started":
      return startAction(snapshot, event);
    case "action.settled":
      return settleAction(snapshot, event);
    case "blocker.started":
      return startBlocker(snapshot, event);
    case "blocker.settled":
      return settleBlocker(snapshot, event);
  }
}

function startWork(
  snapshot: ActivitySnapshotV1,
  event: Extract<ActivityEventV1, { readonly kind: "work.started" }>,
): ActivitySnapshotV1 {
  const current = snapshot.work[event.work.id];
  if (current !== undefined) return snapshot;
  const pending = pendingFor(snapshot, "work", event.work.id);
  const parent = event.work.parentId === undefined ? undefined : snapshot.work[event.work.parentId];
  const phase =
    pending?.outcome ??
    (parent !== undefined && parent.phase !== "running" ? "cancelled" : "running");
  const work: ActivityWorkStateV1 = {
    ...event.work,
    name: event.work.name === undefined ? undefined : normalizeActivityText(event.work.name),
    phase: phase as ActivityWorkPhase,
    settledAt: pending?.settledAt ?? (phase === "cancelled" ? parent?.settledAt : undefined),
    startedAt: event.startedAt,
  };
  return {
    ...snapshot,
    pendingSettlements: removeKey(snapshot.pendingSettlements, pendingKey("work", work.id)),
    work: replaceBounded(snapshot.work, work.id, work),
  };
}

function settleWork(
  snapshot: ActivitySnapshotV1,
  event: Extract<ActivityEventV1, { readonly kind: "work.settled" }>,
): ActivitySnapshotV1 {
  const current = snapshot.work[event.workId];
  if (current === undefined) return retainPending(snapshot, "work", event.workId, event);
  if (current.phase !== "running") return snapshot;
  return {
    ...snapshot,
    actions: cancelOwnedActions(snapshot.actions, event.workId, event.settledAt),
    blockers: cancelOwnedBlockers(snapshot.blockers, event.workId, event.settledAt),
    work: replaceBounded(snapshot.work, event.workId, {
      ...current,
      phase: event.outcome,
      settledAt: event.settledAt,
    }),
  };
}

function startAction(
  snapshot: ActivitySnapshotV1,
  event: Extract<ActivityEventV1, { readonly kind: "action.started" }>,
): ActivitySnapshotV1 {
  if (snapshot.actions[event.action.id] !== undefined) return snapshot;
  const pending = pendingFor(snapshot, "action", event.action.id);
  const parent = snapshot.work[event.action.parentWorkId];
  const phase =
    pending?.outcome ??
    (parent !== undefined && parent.phase !== "running" ? "cancelled" : "running");
  return {
    ...snapshot,
    actions: replaceBounded(snapshot.actions, event.action.id, {
      ...event.action,
      name: normalizeActivityText(event.action.name),
      phase: phase as ActivityActionPhase,
      settledAt: pending?.settledAt ?? (phase === "cancelled" ? parent?.settledAt : undefined),
      startedAt: event.startedAt,
    }),
    pendingSettlements: removeKey(
      snapshot.pendingSettlements,
      pendingKey("action", event.action.id),
    ),
  };
}

function settleAction(
  snapshot: ActivitySnapshotV1,
  event: Extract<ActivityEventV1, { readonly kind: "action.settled" }>,
): ActivitySnapshotV1 {
  const current = snapshot.actions[event.actionId];
  if (current === undefined) return retainPending(snapshot, "action", event.actionId, event);
  if (current.phase !== "running") return snapshot;
  return {
    ...snapshot,
    actions: replaceBounded(snapshot.actions, event.actionId, {
      ...current,
      phase: event.outcome,
      settledAt: event.settledAt,
    }),
  };
}

function startBlocker(
  snapshot: ActivitySnapshotV1,
  event: Extract<ActivityEventV1, { readonly kind: "blocker.started" }>,
): ActivitySnapshotV1 {
  if (snapshot.blockers[event.blocker.id] !== undefined) return snapshot;
  const pending = pendingFor(snapshot, "blocker", event.blocker.id);
  const parent = snapshot.work[event.blocker.parentWorkId];
  const phase =
    pending?.outcome ??
    (parent !== undefined && parent.phase !== "running" ? "cancelled" : "blocked");
  return {
    ...snapshot,
    blockers: replaceBounded(snapshot.blockers, event.blocker.id, {
      ...event.blocker,
      label:
        event.blocker.label === undefined ? undefined : normalizeActivityText(event.blocker.label),
      phase: phase as ActivityBlockerPhase,
      settledAt: pending?.settledAt ?? (phase === "cancelled" ? parent?.settledAt : undefined),
      startedAt: event.startedAt,
    }),
    pendingSettlements: removeKey(
      snapshot.pendingSettlements,
      pendingKey("blocker", event.blocker.id),
    ),
  };
}

function settleBlocker(
  snapshot: ActivitySnapshotV1,
  event: Extract<ActivityEventV1, { readonly kind: "blocker.settled" }>,
): ActivitySnapshotV1 {
  const current = snapshot.blockers[event.blockerId];
  if (current === undefined) return retainPending(snapshot, "blocker", event.blockerId, event);
  if (current.phase !== "blocked") return snapshot;
  return {
    ...snapshot,
    blockers: replaceBounded(snapshot.blockers, event.blockerId, {
      ...current,
      phase: event.outcome,
      settledAt: event.settledAt,
    }),
  };
}

function retainPending(
  snapshot: ActivitySnapshotV1,
  entityKind: PendingActivitySettlementV1["entityKind"],
  entityId: string,
  event: Extract<ActivityEventV1, { readonly kind: `${string}.settled` }>,
): ActivitySnapshotV1 {
  const key = pendingKey(entityKind, entityId);
  if (snapshot.pendingSettlements[key] !== undefined) return snapshot;
  return {
    ...snapshot,
    pendingSettlements: replaceBounded(
      snapshot.pendingSettlements,
      key,
      { entityKind, eventId: event.eventId, outcome: event.outcome, settledAt: event.settledAt },
      MAX_ACTIVITY_PENDING_SETTLEMENTS,
    ),
  };
}

function pendingFor(
  snapshot: ActivitySnapshotV1,
  kind: PendingActivitySettlementV1["entityKind"],
  id: string,
): PendingActivitySettlementV1 | undefined {
  return snapshot.pendingSettlements[pendingKey(kind, id)];
}

function pendingKey(kind: PendingActivitySettlementV1["entityKind"], id: string): string {
  return `${kind}:${id}`;
}

function cancelOwnedActions(
  actions: Readonly<Record<string, ActivityActionStateV1>>,
  parentWorkId: string,
  settledAt: string,
): Readonly<Record<string, ActivityActionStateV1>> {
  return mapOwned(actions, parentWorkId, (action) =>
    action.phase === "running" ? { ...action, phase: "cancelled", settledAt } : action,
  );
}

function cancelOwnedBlockers(
  blockers: Readonly<Record<string, ActivityBlockerStateV1>>,
  parentWorkId: string,
  settledAt: string,
): Readonly<Record<string, ActivityBlockerStateV1>> {
  return mapOwned(blockers, parentWorkId, (blocker) =>
    blocker.phase === "blocked" ? { ...blocker, phase: "cancelled", settledAt } : blocker,
  );
}

function mapOwned<T extends { readonly parentWorkId: string }>(
  values: Readonly<Record<string, T>>,
  parentWorkId: string,
  transform: (value: T) => T,
): Readonly<Record<string, T>> {
  let next = values;
  for (const [id, value] of Object.entries(values)) {
    if (value.parentWorkId !== parentWorkId) continue;
    const transformed = transform(value);
    if (transformed === value) continue;
    if (next === values) next = { ...values };
    (next as Record<string, T>)[id] = transformed;
  }
  return next;
}

function replaceBounded<T>(
  values: Readonly<Record<string, T>>,
  key: string,
  value: T,
  max = MAX_ACTIVITY_ENTITIES,
): Readonly<Record<string, T>> {
  const next = { ...values, [key]: value };
  const overflow = Object.keys(next).length - max;
  for (const oldKey of Object.keys(next).slice(0, Math.max(0, overflow))) delete next[oldKey];
  return next;
}

function removeKey<T>(
  values: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  if (values[key] === undefined) return values;
  const next = { ...values };
  delete next[key];
  return next;
}

function appendBounded<T>(values: readonly T[], value: T, max: number): readonly T[] {
  return [...values, value].slice(-max);
}
