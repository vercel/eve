import { z } from "#compiled/zod/index.js";

export const MAX_PROGRESS_DEDUPLICATION_IDS = 1_000;
export const MAX_PROGRESS_ENTITIES = 500;
export const MAX_PROGRESS_EVENTS_PER_COMMAND = 100;
export const MAX_PROGRESS_TEXT_LENGTH = 500;
export const MAX_PROGRESS_TURNS = 100;

export type ProgressPhase = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

type TerminalProgressPhase = Extract<ProgressPhase, "completed" | "failed" | "cancelled">;

export interface ProgressReportV1 {
  readonly id: string;
  readonly message: string;
  readonly reportedAt: string;
}

export interface ProgressTurnV1 {
  readonly id: string;
  readonly sequence: number;
  readonly phase: ProgressPhase;
  readonly startedAt: string;
  readonly settledAt?: string;
  readonly report?: ProgressReportV1;
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
    }
  | {
      readonly kind: "report";
      readonly eventId: string;
      readonly turn: ProgressTurnV1;
      readonly report: ProgressReportV1;
    };

const progressPhaseSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
const progressReportSchema = z
  .object({ id: z.string().min(1), message: z.string(), reportedAt: z.string().min(1) })
  .strict();
const progressTurnSchema = z
  .object({
    id: z.string().min(1),
    phase: progressPhaseSchema,
    report: progressReportSchema.optional(),
    sequence: z.number().int().nonnegative(),
    settledAt: z.string().optional(),
    startedAt: z.string().min(1),
  })
  .strict();
const progressEntitySchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["tool", "subagent", "remote-agent", "skill", "blocker"]),
    label: z.string(),
    phase: progressPhaseSchema,
    turnId: z.string().min(1),
  })
  .strict();
export const progressCommandV1Schema = z
  .object({
    commandId: z.string().min(1),
    events: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              eventId: z.string().min(1),
              kind: z.literal("turn"),
              turn: progressTurnSchema,
            })
            .strict(),
          z
            .object({
              entity: progressEntitySchema,
              eventId: z.string().min(1),
              kind: z.literal("entity"),
            })
            .strict(),
          z
            .object({
              eventId: z.string().min(1),
              kind: z.literal("report"),
              report: progressReportSchema,
              turn: progressTurnSchema,
            })
            .strict(),
        ]),
      )
      .max(MAX_PROGRESS_EVENTS_PER_COMMAND),
    kind: z.literal("progress"),
    version: z.literal(1),
  })
  .strict();

export function parseProgressCommandV1(value: unknown): ProgressCommandV1 | undefined {
  const parsed = progressCommandV1Schema.safeParse(value);
  return parsed.success ? (parsed.data as ProgressCommandV1) : undefined;
}

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
  let acceptedEvent = false;
  for (const event of command.events.slice(0, MAX_PROGRESS_EVENTS_PER_COMMAND)) {
    if (next.seenEventIds.includes(event.eventId)) continue;
    acceptedEvent = true;
    next = reduceEvent(next, event);
    next = { ...next, seenEventIds: appendBounded(next.seenEventIds, event.eventId) };
  }
  return acceptedEvent ? { ...next, revision: next.revision + 1 } : next;
}

function reduceEvent(snapshot: ProgressSnapshotV1, event: ProgressEventV1): ProgressSnapshotV1 {
  if (event.kind === "turn" || event.kind === "report") {
    const incoming = event.kind === "report" ? { ...event.turn, report: event.report } : event.turn;
    const current = snapshot.turns[incoming.id];
    if (current !== undefined && isTerminal(current.phase)) return snapshot;
    const turn =
      current === undefined
        ? incoming
        : isTerminal(incoming.phase)
          ? { ...incoming, startedAt: current.startedAt }
          : { ...current, ...incoming, startedAt: current.startedAt };
    return {
      ...snapshot,
      turns: appendBoundedRecord(snapshot.turns, turn.id, turn, MAX_PROGRESS_TURNS),
    };
  }

  const current = snapshot.entities[event.entity.id];
  if (current !== undefined && isTerminal(current.phase)) return snapshot;
  const incoming = { ...event.entity, label: normalizeProgressText(event.entity.label) };
  const entity = current === undefined ? incoming : { ...current, ...incoming };
  return {
    ...snapshot,
    entities: appendBoundedRecord(snapshot.entities, entity.id, entity, MAX_PROGRESS_ENTITIES),
  };
}

function appendBoundedRecord<T>(
  values: Readonly<Record<string, T>>,
  key: string,
  value: T,
  max: number,
): Readonly<Record<string, T>> {
  const next = { ...values, [key]: value };
  const overflow = Object.keys(next).length - max;
  if (overflow <= 0) return next;
  for (const oldKey of Object.keys(next).slice(0, overflow)) delete next[oldKey];
  return next;
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
