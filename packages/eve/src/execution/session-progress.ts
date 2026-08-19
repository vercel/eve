export const MAX_PROGRESS_DEDUPLICATION_IDS = 1_000;
export const MAX_PROGRESS_TEXT_LENGTH = 500;

export type ProgressPhase = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

type TerminalProgressPhase = Extract<ProgressPhase, "completed" | "failed" | "cancelled">;

export interface ProgressTurnV1 {
  readonly id: string;
  readonly sequence: number;
  readonly phase: ProgressPhase;
  readonly startedAt: string;
  readonly settledAt?: string;
}

export interface ProgressEntityV1 {
  readonly id: string;
  readonly turnId: string;
  readonly kind: "tool" | "subagent" | "remote-agent" | "skill" | "blocker";
  readonly label: string;
  readonly phase: ProgressPhase;
}

/** Complete bounded status state owned by the session driver. */
export interface ProgressSnapshotV1 {
  readonly version: 1;
  readonly revision: number;
  readonly turns: Readonly<Record<string, ProgressTurnV1>>;
  readonly entities: Readonly<Record<string, ProgressEntityV1>>;
  readonly seenCommandIds: readonly string[];
  readonly seenEventIds: readonly string[];
}

/** Driver-owned presentation boundary; renderers receive no turn or channel context. */
export interface SessionProgressHandler {
  handleProgress(command: ProgressCommandV1): Promise<void>;
}

export interface ProgressCommandV1 {
  readonly kind: "progress";
  readonly version: 1;
  readonly commandId: string;
  readonly events: readonly ProgressEventV1[];
}

export type ProgressEventV1 =
  | {
      readonly kind: "turn";
      readonly eventId: string;
      readonly turn: ProgressTurnV1;
    }
  | {
      readonly kind: "entity";
      readonly eventId: string;
      readonly entity: ProgressEntityV1;
    };

export function progressTurnId(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

export function progressActionId(sessionId: string, callId: string): string {
  return `action:${sessionId}:${callId}`;
}

export function createProgressSnapshot(): ProgressSnapshotV1 {
  return {
    entities: {},
    revision: 0,
    seenCommandIds: [],
    seenEventIds: [],
    turns: {},
    version: 1,
  };
}

/** Applies a progress command exactly once while keeping terminal state monotonic. */
export function reduceProgressCommand(
  snapshot: ProgressSnapshotV1,
  command: ProgressCommandV1,
): ProgressSnapshotV1 {
  if (snapshot.seenCommandIds.includes(command.commandId)) return snapshot;

  let next: ProgressSnapshotV1 = {
    ...snapshot,
    seenCommandIds: appendBounded(snapshot.seenCommandIds, command.commandId),
  };
  for (const event of command.events) {
    if (next.seenEventIds.includes(event.eventId)) continue;
    next = reduceEvent(next, event);
    next = { ...next, seenEventIds: appendBounded(next.seenEventIds, event.eventId) };
  }
  return next.seenEventIds.length === snapshot.seenEventIds.length
    ? next
    : { ...next, revision: next.revision + 1 };
}

function reduceEvent(snapshot: ProgressSnapshotV1, event: ProgressEventV1): ProgressSnapshotV1 {
  if (event.kind === "turn") {
    const current = snapshot.turns[event.turn.id];
    if (current !== undefined && isTerminal(current.phase)) return snapshot;
    const turn =
      current === undefined ? event.turn : { ...event.turn, startedAt: current.startedAt };
    return { ...snapshot, turns: { ...snapshot.turns, [turn.id]: turn } };
  }

  const current = snapshot.entities[event.entity.id];
  if (current !== undefined && isTerminal(current.phase)) return snapshot;
  const entity = current === undefined ? event.entity : { ...current, ...event.entity };
  return { ...snapshot, entities: { ...snapshot.entities, [entity.id]: entity } };
}

function isTerminal(phase: ProgressPhase): phase is TerminalProgressPhase {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

function appendBounded<T>(items: readonly T[], item: T): readonly T[] {
  return [...items, item].slice(-MAX_PROGRESS_DEDUPLICATION_IDS);
}

/** Collapses control characters and whitespace before untrusted text reaches a renderer. */
export function normalizeProgressText(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROGRESS_TEXT_LENGTH);
}
