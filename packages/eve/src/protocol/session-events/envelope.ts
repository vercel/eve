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

export type TransportRecord =
  | PositionMarker
  | { readonly $eve: "heartbeat" }
  | { readonly $eve: "stream.lease-ended" }
  | { readonly $eve: "stream.ended" };

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

export type ReadRecord<TFact = unknown, TProgress = unknown> =
  | { readonly kind: "commit"; readonly line: CommitLine<TFact> }
  | { readonly kind: "progress"; readonly line: ProgressLine<TProgress> }
  | { readonly kind: "transport"; readonly record: TransportRecord }
  | { readonly kind: "unknown-transport"; readonly name: string }
  | { readonly kind: "invalid"; readonly value: unknown };

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
          : { kind: "unknown-transport", name: record.$eve };
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

export function isStoredLine(value: unknown): value is StoredLine {
  const { kind } = classifyRecord(value);
  return kind === "commit" || kind === "progress";
}

export function encodeLine(line: StoredLine | TransportRecord): string {
  return `${JSON.stringify(line)}\n`;
}

export const MAX_SESSION_LINE_BYTES = 8 * 1024 * 1024;

export class SessionLineTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(
      `Session commit is ${bytes} bytes; the limit is ${MAX_SESSION_LINE_BYTES}. ` +
        "A commit cannot be split. Reduce inline content or use a supported value reference.",
    );
    this.name = "SessionLineTooLargeError";
    this.bytes = bytes;
  }
}

const lineEncoder = new TextEncoder();

export function encodeLineBytes(line: StoredLine | TransportRecord): Uint8Array {
  const bytes = lineEncoder.encode(encodeLine(line));
  if (bytes.byteLength > MAX_SESSION_LINE_BYTES)
    throw new SessionLineTooLargeError(bytes.byteLength);
  return bytes;
}

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

/** Who submitted a delivery, as its channel authenticated them. */
export interface Principal {
  readonly id: string;
  /** Open: `"user"` and `"app"` today. */
  readonly type: string;
  readonly issuer?: string;
}

/** A failure's code and its human-readable message. Codes are open strings. */
export interface ErrorInfo {
  /** The thrown error's class name, when a producer knows it. */
  readonly name?: string;
  readonly code: string;
  readonly message: string;
  /** An id to quote when asking for support; the server's logs carry the same id. */
  readonly id?: string;
  /** What to do about it, when eve recognizes the failure: a person-facing remedy. */
  readonly hint?: string;
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

export type { JsonValue } from "./json.js";

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
