import { opaque, reveal, type Opaque } from "#execution/durable.js";
import type { SessionTransferState } from "#execution/session/checkpoint.js";
import type { OpenTurn } from "#execution/session/open-turn.js";

export const SESSION_LIMITS = { stepResultBytes: 262_144, recordBytes: 262_144 } as const;

export const SESSION_RECORD_VERSION = 1;

/** The record of a session that an engine keeps. It is JSON, and an engine passes it back as is. */
export type SessionRecord = Opaque<"eve.session-record">;

export interface SessionRecordContents {
  readonly version: number;
  readonly generation: number;
  readonly transfer: SessionTransferState;
  readonly open: OpenTurn | undefined;
  readonly timeoutDeadline?: number;
  readonly sessionCode?: string;
}

export class SessionRecordTooNew extends Error {
  readonly version: number;

  constructor(version: number) {
    super(
      `This session's record has version ${version}, and this eve reads records up to version ${SESSION_RECORD_VERSION}. Continue the session on the eve version that wrote the record, or on a newer one.`,
    );
    this.name = "SessionRecordTooNew";
    this.version = version;
  }
}

export function sealSessionRecord(contents: Omit<SessionRecordContents, "version">): SessionRecord {
  const sealed: SessionRecordContents = { version: SESSION_RECORD_VERSION, ...contents };
  const bytes = new TextEncoder().encode(JSON.stringify(sealed)).byteLength;
  if (bytes > SESSION_LIMITS.recordBytes) {
    throw new Error(
      `The session record is ${bytes} bytes, over the ${SESSION_LIMITS.recordBytes}-byte limit. Give the engine a content store so the session's history and state go out of line.`,
    );
  }
  return opaque(sealed);
}

export function openSessionRecord(record: SessionRecord): SessionRecordContents {
  const contents = reveal<SessionRecordContents>(record);
  if (contents.version > SESSION_RECORD_VERSION) throw new SessionRecordTooNew(contents.version);
  return contents;
}
