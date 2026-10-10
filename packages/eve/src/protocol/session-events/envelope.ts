// The session stream's envelope: what a stored line is, and the values facts share.
//
// This module is the wire contract, so it stands alone: nothing here imports runtime code, the
// AI SDK, or Zod. Schemas live beside it for tests and development (`schemas.ts`), and readers
// use the plain types and the runtime catalog (`catalog.ts`).

/**
 * One line of a session stream: a commit, which holds every fact of one transition, or one
 * progress record. A line's zero-based index in the stream is its position, and its identity.
 */
export type StoredLine<TFact = unknown, TProgress = unknown> =
  | CommitLine<TFact>
  | ProgressLine<TProgress>;

/** Every fact one transition recorded, in order, with the time the writer wrote them. */
export interface CommitLine<TFact = unknown> {
  /** When the writer wrote the line, as ISO 8601 in UTC. For display and durations, never order. */
  readonly at: string;
  /** Never empty. A fact may reference an entity an earlier fact in the same line introduced. */
  readonly facts: readonly TFact[];
}

/** A preview of a value a later fact completes. Any progress record may be missing. */
export interface ProgressLine<TProgress = unknown> {
  readonly progress: TProgress;
}

/**
 * The owners a fact belongs to, stamped by the publisher. Owners never change, so a scope never
 * goes stale; readers that don't fold use it to place a fact.
 */
export interface Scope {
  readonly turnId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly changeId?: string;
}

/** A fact or progress record: its type (`family.verb`), its owners, and its payload. */
export interface Envelope<TType extends string, TData> {
  readonly type: TType;
  readonly scope?: Scope;
  readonly data: TData;
}

/**
 * Records the stream route writes into a response. They are never stored and never counted, and
 * readers ignore the ones they don't know.
 */
export type TransportRecord =
  | PositionMarker
  | { readonly $eve: "heartbeat" }
  | { readonly $eve: "stream.lease-ended" }
  | { readonly $eve: "stream.ended" };

/** Written after lines a read skipped: the position of the next line the response sends. */
export interface PositionMarker {
  readonly $eve: "position";
  readonly next: number;
}

export const HEARTBEAT_RECORD = { $eve: "heartbeat" } as const satisfies TransportRecord;
export const LEASE_ENDED_RECORD = { $eve: "stream.lease-ended" } as const satisfies TransportRecord;
export const STREAM_ENDED_RECORD = { $eve: "stream.ended" } as const satisfies TransportRecord;

/** Where one fact or progress record sits: its line's position, and its index in the line. */
export interface FactPosition {
  readonly line: number;
  readonly index: number;
}

/** What one record read from a response is. */
export type ReadRecord<TFact = unknown, TProgress = unknown> =
  | { readonly kind: "commit"; readonly line: CommitLine<TFact> }
  | { readonly kind: "progress"; readonly line: ProgressLine<TProgress> }
  | { readonly kind: "transport"; readonly record: TransportRecord }
  | { readonly kind: "unknown-transport"; readonly name: string }
  | { readonly kind: "invalid"; readonly value: unknown };

/** Tells the kinds of record apart by key, as every reader does. */
export function classifyRecord<TFact = unknown, TProgress = unknown>(
  value: unknown,
): ReadRecord<TFact, TProgress> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid", value };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.$eve === "string") {
    switch (record.$eve) {
      case "position":
        return typeof record.next === "number" && Number.isSafeInteger(record.next)
          ? { kind: "transport", record: { $eve: "position", next: record.next } }
          : { kind: "invalid", value };
      case "heartbeat":
      case "stream.lease-ended":
      case "stream.ended":
        return { kind: "transport", record: { $eve: record.$eve } };
      default:
        return { kind: "unknown-transport", name: record.$eve };
    }
  }
  if (Array.isArray(record.facts) && typeof record.at === "string") {
    return { kind: "commit", line: value as CommitLine<TFact> };
  }
  if (record.progress !== null && typeof record.progress === "object") {
    return { kind: "progress", line: value as ProgressLine<TProgress> };
  }
  return { kind: "invalid", value };
}

/** True for a stored line: a commit or a progress record. */
export function isStoredLine(value: unknown): value is StoredLine {
  const { kind } = classifyRecord(value);
  return kind === "commit" || kind === "progress";
}

/** The records of one line, in order: a commit's facts, or the one progress record. */
export function recordsOf<TFact, TProgress>(
  line: StoredLine<TFact, TProgress>,
): readonly (TFact | TProgress)[] {
  return "facts" in line ? line.facts : [line.progress];
}

/** Encodes one stored line as NDJSON. */
export function encodeLine(line: StoredLine | TransportRecord): string {
  return `${JSON.stringify(line)}\n`;
}

// ---------------------------------------------------------------------------
// Values facts share
// ---------------------------------------------------------------------------

/**
 * What caused something, by the entity that did. The set is open: a reader that meets a cause it
 * doesn't know treats it as the system's.
 */
export type Cause =
  | { readonly deliveryId: string }
  | { readonly turnId: string }
  | { readonly taskId: string }
  | { readonly callId: string }
  | { readonly interactionId: string }
  | { readonly responseId: string }
  | { readonly changeId: string }
  | { readonly policy: string }
  | { readonly hook: string };

/** The key that names a cause's kind. */
export type CauseKind =
  | "deliveryId"
  | "turnId"
  | "taskId"
  | "callId"
  | "interactionId"
  | "responseId"
  | "changeId"
  | "policy"
  | "hook";

const CAUSE_KINDS: readonly CauseKind[] = [
  "deliveryId",
  "turnId",
  "taskId",
  "callId",
  "interactionId",
  "responseId",
  "changeId",
  "policy",
  "hook",
];

/** A cause's kind, or `"system"` for a cause this reader doesn't know. */
export function causeKind(cause: object | undefined): CauseKind | "system" {
  if (cause === undefined) return "system";
  for (const kind of CAUSE_KINDS) {
    if (typeof (cause as Record<string, unknown>)[kind] === "string") return kind;
  }
  return "system";
}

/** Who submitted a delivery, as its channel authenticated them. */
export interface Principal {
  readonly id: string;
  /** Open: `"user"` and `"app"` today. */
  readonly type: string;
  readonly issuer?: string;
}

/** A failure's code and its human-readable message. Codes are open strings. */
export interface ErrorInfo {
  readonly code: string;
  readonly message: string;
}

/** Tokens and cost one unit of work spent. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Absent when the provider reported no cost. */
  readonly costUsd?: number;
}

/**
 * A value carried by reference instead of inline: too large for a line, or withheld. A field
 * that may be large has an inline slot and a `…Ref` slot, so absent, inline, referenced, and
 * withheld values stay distinct.
 */
export interface ValueReference {
  /** Resolved through a session-scoped route. Absent when the value is withheld. */
  readonly ref?: string;
  readonly mediaType?: string;
  readonly size?: number;
  /** A short preview for display. */
  readonly preview?: string;
  /** The value exists but isn't published. */
  readonly withheld?: true;
}

/** Any JSON value. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** One part of what a person sent. The kind set is open. */
export type UserPart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "file";
      readonly mediaType: string;
      readonly filename?: string;
      readonly size?: number;
      /** Absent with `unavailable` when no store holds the file. */
      readonly ref?: string;
      readonly url?: string;
      readonly unavailable?: true;
    };
