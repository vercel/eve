export const MAX_ACTIVITY_EVENTS_PER_BATCH = 100;
export const MAX_ACTIVITY_EVENT_IDS = 1_000;
export const MAX_ACTIVITY_PENDING_SETTLEMENTS = 500;
export const MAX_ACTIVITY_ENTITIES = 500;

export const EVE_ACTIVITY_STREAM_CONTENT_TYPE = "application/x-ndjson";
export const EVE_ACTIVITY_STREAM_FORMAT = "eve-activity-snapshot-ndjson";
export const EVE_ACTIVITY_STREAM_VERSION = "1";

export type ActivityWorkKind = "root-turn" | "subagent" | "remote-agent" | "task";
export type ActivityWorkPhase = "running" | "completed" | "failed" | "cancelled";
export type ActivityActionKind = "tool" | "skill";
export type ActivityActionPhase = "running" | "completed" | "failed" | "rejected" | "cancelled";
export type ActivityBlockerKind = "approval" | "authorization" | "input";
export type ActivityBlockerPhase = "blocked" | "completed" | "cancelled" | "failed";

export interface ActivityWorkIdentityV1 {
  readonly callId?: string;
  readonly id: string;
  readonly kind: ActivityWorkKind;
  readonly name?: string;
  readonly parentId?: string;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface PendingActivitySettlementV1 {
  readonly entityKind: "action" | "blocker" | "work";
  readonly eventId: string;
  readonly outcome: ActivityActionPhase | ActivityBlockerPhase | ActivityWorkPhase;
  readonly settledAt: string;
}

export interface ActivityWorkStateV1 extends ActivityWorkIdentityV1 {
  readonly phase: ActivityWorkPhase;
  readonly settledAt?: string;
  readonly startedAt: string;
}

export interface ActivityActionIdentityV1 {
  readonly id: string;
  readonly kind: ActivityActionKind;
  readonly name: string;
  readonly parentWorkId: string;
  readonly rootTurnId: string;
  readonly stepIndex: number;
}

export interface ActivityActionStateV1 extends ActivityActionIdentityV1 {
  readonly label?: string;
  readonly phase: ActivityActionPhase;
  readonly settledAt?: string;
  readonly startedAt: string;
}

export interface ActivityBlockerIdentityV1 {
  readonly id: string;
  readonly kind: ActivityBlockerKind;
  readonly label?: string;
  readonly parentActionId?: string;
  readonly parentWorkId: string;
  readonly rootTurnId: string;
}

export interface ActivityBlockerStateV1 extends ActivityBlockerIdentityV1 {
  readonly phase: ActivityBlockerPhase;
  readonly settledAt?: string;
  readonly startedAt: string;
}

export type ActivityEventV1 =
  | {
      readonly eventId: string;
      readonly kind: "work.started";
      readonly startedAt: string;
      readonly work: ActivityWorkIdentityV1;
    }
  | {
      readonly eventId: string;
      readonly kind: "work.settled";
      readonly outcome: Exclude<ActivityWorkPhase, "running">;
      readonly settledAt: string;
      readonly workId: string;
    }
  | {
      readonly action: ActivityActionIdentityV1;
      readonly eventId: string;
      readonly kind: "action.started";
      readonly startedAt: string;
    }
  | {
      readonly actionId: string;
      readonly eventId: string;
      readonly kind: "action.settled";
      readonly outcome: Exclude<ActivityActionPhase, "running">;
      readonly settledAt: string;
    }
  | {
      readonly actionId: string;
      readonly eventId: string;
      readonly kind: "action.label.updated";
      readonly label: string;
    }
  | {
      readonly blocker: ActivityBlockerIdentityV1;
      readonly eventId: string;
      readonly kind: "blocker.started";
      readonly startedAt: string;
    }
  | {
      readonly blockerId: string;
      readonly eventId: string;
      readonly kind: "blocker.settled";
      readonly outcome: Exclude<ActivityBlockerPhase, "blocked">;
      readonly settledAt: string;
    };

export interface ActivityBatchV1 {
  readonly events: readonly ActivityEventV1[];
  readonly version: 1;
}

export interface ActivitySnapshotV1 {
  readonly actions: Readonly<Record<string, ActivityActionStateV1>>;
  readonly blockers: Readonly<Record<string, ActivityBlockerStateV1>>;
  readonly pendingSettlements: Readonly<Record<string, PendingActivitySettlementV1>>;
  readonly revision: number;
  readonly seenEventIds: readonly string[];
  readonly version: 1;
  readonly work: Readonly<Record<string, ActivityWorkStateV1>>;
}

/** Parses a complete persisted activity snapshot at the version 1 protocol boundary. */
export function parseActivitySnapshotV1(value: unknown): ActivitySnapshotV1 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "actions",
      "blockers",
      "pendingSettlements",
      "revision",
      "seenEventIds",
      "version",
      "work",
    ]) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isBoundedStringArray(value.seenEventIds, MAX_ACTIVITY_EVENT_IDS)
  )
    return undefined;

  const actions = parseStateRecord(value.actions, MAX_ACTIVITY_ENTITIES, (candidate, key) => {
    const state = parseActionState(candidate);
    return state?.id === key ? state : undefined;
  });
  const blockers = parseStateRecord(value.blockers, MAX_ACTIVITY_ENTITIES, (candidate, key) => {
    const state = parseBlockerState(candidate);
    return state?.id === key ? state : undefined;
  });
  const pendingSettlements = parseStateRecord(
    value.pendingSettlements,
    MAX_ACTIVITY_PENDING_SETTLEMENTS,
    (candidate, key) => {
      const state = parsePendingSettlement(candidate);
      return state !== undefined && isPendingSettlementKey(key, state.entityKind)
        ? state
        : undefined;
    },
    isPotentialPendingSettlementKey,
  );
  const work = parseStateRecord(value.work, MAX_ACTIVITY_ENTITIES, (candidate, key) => {
    const state = parseWorkState(candidate);
    return state?.id === key ? state : undefined;
  });
  if (
    actions === undefined ||
    blockers === undefined ||
    pendingSettlements === undefined ||
    work === undefined
  )
    return undefined;

  return {
    actions,
    blockers,
    pendingSettlements,
    revision: value.revision as number,
    seenEventIds: value.seenEventIds,
    version: 1,
    work,
  };
}

export function parseActivityWorkIdentityV1(value: unknown): ActivityWorkIdentityV1 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "callId",
      "id",
      "kind",
      "name",
      "parentId",
      "rootSessionId",
      "rootTurnId",
      "sessionId",
      "turnId",
    ])
  )
    return undefined;
  const kind = value.kind;
  if (
    !isOneOf(kind, ["root-turn", "subagent", "remote-agent", "task"] as const) ||
    !isIdentity(value.id) ||
    !isIdentity(value.rootSessionId) ||
    !isIdentity(value.rootTurnId) ||
    !isOptionalIdentity(value.callId) ||
    !isOptionalBoundedString(value.name) ||
    !isOptionalIdentity(value.parentId) ||
    !isOptionalIdentity(value.sessionId) ||
    !isOptionalIdentity(value.turnId)
  )
    return undefined;
  return {
    callId: value.callId,
    id: value.id,
    kind,
    name: value.name,
    parentId: value.parentId,
    rootSessionId: value.rootSessionId,
    rootTurnId: value.rootTurnId,
    sessionId: value.sessionId,
    turnId: value.turnId,
  };
}

/** Parses known lifecycle events while ignoring additive unknown event kinds. */
export function parseActivityBatchV1(value: unknown): ActivityBatchV1 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["events", "version"]) ||
    value.version !== 1 ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_ACTIVITY_EVENTS_PER_BATCH
  )
    return undefined;

  const events: ActivityEventV1[] = [];
  for (const candidate of value.events) {
    if (!isRecord(candidate) || !isBoundedString(candidate.kind)) return undefined;
    const event = parseKnownEvent(candidate);
    if (event === null) continue;
    if (event === undefined) return undefined;
    events.push(event);
  }
  return { events, version: 1 };
}

function parseKnownEvent(value: Record<string, unknown>): ActivityEventV1 | null | undefined {
  switch (value.kind) {
    case "work.started": {
      if (!hasOnlyKeys(value, ["eventId", "kind", "startedAt", "work"])) return undefined;
      const work = parseActivityWorkIdentityV1(value.work);
      if (!isIdentity(value.eventId) || !isBoundedString(value.startedAt) || work === undefined)
        return undefined;
      return { eventId: value.eventId, kind: "work.started", startedAt: value.startedAt, work };
    }
    case "work.settled": {
      if (!hasOnlyKeys(value, ["eventId", "kind", "outcome", "settledAt", "workId"]))
        return undefined;
      if (
        !isIdentity(value.eventId) ||
        !isOneOf(value.outcome, ["completed", "failed", "cancelled"] as const) ||
        !isBoundedString(value.settledAt) ||
        !isIdentity(value.workId)
      )
        return undefined;
      return {
        eventId: value.eventId,
        kind: "work.settled",
        outcome: value.outcome,
        settledAt: value.settledAt,
        workId: value.workId,
      };
    }
    case "action.started": {
      if (!hasOnlyKeys(value, ["action", "eventId", "kind", "startedAt"])) return undefined;
      const action = parseActionIdentity(value.action);
      if (!isIdentity(value.eventId) || !isBoundedString(value.startedAt) || action === undefined)
        return undefined;
      return { action, eventId: value.eventId, kind: "action.started", startedAt: value.startedAt };
    }
    case "action.settled": {
      if (!hasOnlyKeys(value, ["actionId", "eventId", "kind", "outcome", "settledAt"]))
        return undefined;
      if (
        !isIdentity(value.actionId) ||
        !isIdentity(value.eventId) ||
        !isOneOf(value.outcome, ["completed", "failed", "rejected", "cancelled"] as const) ||
        !isBoundedString(value.settledAt)
      )
        return undefined;
      return {
        actionId: value.actionId,
        eventId: value.eventId,
        kind: "action.settled",
        outcome: value.outcome,
        settledAt: value.settledAt,
      };
    }
    case "action.label.updated": {
      if (!hasOnlyKeys(value, ["actionId", "eventId", "kind", "label"])) return undefined;
      if (
        !isIdentity(value.actionId) ||
        !isIdentity(value.eventId) ||
        !isBoundedString(value.label)
      )
        return undefined;
      return {
        actionId: value.actionId,
        eventId: value.eventId,
        kind: "action.label.updated",
        label: value.label,
      };
    }
    case "blocker.started": {
      if (!hasOnlyKeys(value, ["blocker", "eventId", "kind", "startedAt"])) return undefined;
      const blocker = parseBlockerIdentity(value.blocker);
      if (!isIdentity(value.eventId) || !isBoundedString(value.startedAt) || blocker === undefined)
        return undefined;
      return {
        blocker,
        eventId: value.eventId,
        kind: "blocker.started",
        startedAt: value.startedAt,
      };
    }
    case "blocker.settled": {
      if (!hasOnlyKeys(value, ["blockerId", "eventId", "kind", "outcome", "settledAt"]))
        return undefined;
      if (
        !isIdentity(value.blockerId) ||
        !isIdentity(value.eventId) ||
        !isOneOf(value.outcome, ["completed", "cancelled", "failed"] as const) ||
        !isBoundedString(value.settledAt)
      )
        return undefined;
      return {
        blockerId: value.blockerId,
        eventId: value.eventId,
        kind: "blocker.settled",
        outcome: value.outcome,
        settledAt: value.settledAt,
      };
    }
    default:
      return null;
  }
}

function parseWorkState(value: unknown): ActivityWorkStateV1 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "callId",
      "id",
      "kind",
      "name",
      "parentId",
      "phase",
      "rootSessionId",
      "rootTurnId",
      "sessionId",
      "settledAt",
      "startedAt",
      "turnId",
    ])
  )
    return undefined;
  const identity = parseActivityWorkIdentityV1(
    omitStateKeys(value, ["phase", "settledAt", "startedAt"]),
  );
  if (
    identity === undefined ||
    !isOneOf(value.phase, ["running", "completed", "failed", "cancelled"] as const) ||
    !isOptionalBoundedString(value.settledAt) ||
    !isBoundedString(value.startedAt) ||
    !hasConsistentSettlement(value.phase, value.settledAt, "running")
  )
    return undefined;
  return {
    ...identity,
    phase: value.phase,
    settledAt: value.settledAt,
    startedAt: value.startedAt,
  };
}

function parseActionState(value: unknown): ActivityActionStateV1 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "kind",
      "label",
      "name",
      "parentWorkId",
      "phase",
      "rootTurnId",
      "settledAt",
      "startedAt",
      "stepIndex",
    ])
  )
    return undefined;
  const identity = parseActionIdentity(
    omitStateKeys(value, ["label", "phase", "settledAt", "startedAt"]),
  );
  if (
    identity === undefined ||
    !isOptionalBoundedString(value.label) ||
    !isOneOf(value.phase, ["running", "completed", "failed", "rejected", "cancelled"] as const) ||
    !isOptionalBoundedString(value.settledAt) ||
    !isBoundedString(value.startedAt) ||
    !hasConsistentSettlement(value.phase, value.settledAt, "running")
  )
    return undefined;
  return {
    ...identity,
    label: value.label,
    phase: value.phase,
    settledAt: value.settledAt,
    startedAt: value.startedAt,
  };
}

function parseBlockerState(value: unknown): ActivityBlockerStateV1 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "kind",
      "label",
      "parentActionId",
      "parentWorkId",
      "phase",
      "rootTurnId",
      "settledAt",
      "startedAt",
    ])
  )
    return undefined;
  const identity = parseBlockerIdentity(omitStateKeys(value, ["phase", "settledAt", "startedAt"]));
  if (
    identity === undefined ||
    !isOneOf(value.phase, ["blocked", "completed", "cancelled", "failed"] as const) ||
    !isOptionalBoundedString(value.settledAt) ||
    !isBoundedString(value.startedAt) ||
    !hasConsistentSettlement(value.phase, value.settledAt, "blocked")
  )
    return undefined;
  return {
    ...identity,
    phase: value.phase,
    settledAt: value.settledAt,
    startedAt: value.startedAt,
  };
}

function parsePendingSettlement(value: unknown): PendingActivitySettlementV1 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["entityKind", "eventId", "outcome", "settledAt"]) ||
    !isOneOf(value.entityKind, ["action", "blocker", "work"] as const) ||
    !isIdentity(value.eventId) ||
    !isBoundedString(value.settledAt)
  )
    return undefined;
  const validOutcome =
    value.entityKind === "action"
      ? isOneOf(value.outcome, ["completed", "failed", "rejected", "cancelled"] as const)
      : value.entityKind === "blocker"
        ? isOneOf(value.outcome, ["completed", "cancelled", "failed"] as const)
        : isOneOf(value.outcome, ["completed", "failed", "cancelled"] as const);
  if (!validOutcome) return undefined;
  return {
    entityKind: value.entityKind,
    eventId: value.eventId,
    outcome: value.outcome as PendingActivitySettlementV1["outcome"],
    settledAt: value.settledAt,
  };
}

function parseActionIdentity(value: unknown): ActivityActionIdentityV1 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "kind", "name", "parentWorkId", "rootTurnId", "stepIndex"])
  )
    return undefined;
  if (
    !isIdentity(value.id) ||
    !isOneOf(value.kind, ["tool", "skill"] as const) ||
    !isBoundedString(value.name) ||
    !isIdentity(value.parentWorkId) ||
    !isIdentity(value.rootTurnId) ||
    !Number.isSafeInteger(value.stepIndex) ||
    (value.stepIndex as number) < 0
  )
    return undefined;
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    parentWorkId: value.parentWorkId,
    rootTurnId: value.rootTurnId,
    stepIndex: value.stepIndex as number,
  };
}

function parseBlockerIdentity(value: unknown): ActivityBlockerIdentityV1 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "kind", "label", "parentActionId", "parentWorkId", "rootTurnId"])
  )
    return undefined;
  if (
    !isIdentity(value.id) ||
    !isOneOf(value.kind, ["approval", "authorization", "input"] as const) ||
    !isOptionalBoundedString(value.label) ||
    !isOptionalIdentity(value.parentActionId) ||
    !isIdentity(value.parentWorkId) ||
    !isIdentity(value.rootTurnId)
  )
    return undefined;
  return {
    id: value.id,
    kind: value.kind,
    label: value.label,
    parentActionId: value.parentActionId,
    parentWorkId: value.parentWorkId,
    rootTurnId: value.rootTurnId,
  };
}

function parseStateRecord<T>(
  value: unknown,
  maxSize: number,
  parse: (value: unknown, key: string) => T | undefined,
  isValidKey: (key: string) => boolean = isIdentity,
): Readonly<Record<string, T>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > maxSize) return undefined;
  const parsed: Array<readonly [string, T]> = [];
  for (const [key, candidate] of entries) {
    if (!isValidKey(key)) return undefined;
    const state = parse(candidate, key);
    if (state === undefined) return undefined;
    parsed.push([key, state]);
  }
  return Object.fromEntries(parsed);
}

function omitStateKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function hasConsistentSettlement(phase: unknown, settledAt: unknown, activePhase: string): boolean {
  return phase === activePhase ? settledAt === undefined : isBoundedString(settledAt);
}

function isPendingSettlementKey(
  key: string,
  entityKind: PendingActivitySettlementV1["entityKind"],
): boolean {
  const prefix = `${entityKind}:`;
  return key.startsWith(prefix) && isIdentity(key.slice(prefix.length));
}

function isPotentialPendingSettlementKey(key: string): boolean {
  return (["action", "blocker", "work"] as const).some((kind) => isPendingSettlementKey(key, kind));
}

function isBoundedStringArray(value: unknown, maxSize: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxSize &&
    new Set(value).size === value.length &&
    value.every((candidate) => isIdentity(candidate))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}
function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_000;
}
function isOptionalIdentity(value: unknown): value is string | undefined {
  return value === undefined || isIdentity(value);
}
function isOptionalBoundedString(value: unknown): value is string | undefined {
  return value === undefined || isBoundedString(value);
}
function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}
