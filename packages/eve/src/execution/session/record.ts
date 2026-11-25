import { opaque, reveal, type Opaque, type SessionContentStore } from "#execution/durable.js";
import type { SessionTransferState } from "#execution/session/checkpoint.js";
import type { OpenTurn } from "#execution/session/open-turn.js";

export const SESSION_LIMITS = { stepResultBytes: 262_144, recordBytes: 262_144 } as const;

export const SESSION_RECORD_VERSION = 1;

export type SessionRecord = Opaque<"eve.session-record">;

export interface SessionRecordContents {
  readonly version: number;
  readonly generation: number;
  readonly transfer: SessionTransferState;
  readonly open: OpenTurn | undefined;
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

export interface SessionRecordContent {
  readonly sessionId: string;
  readonly content: SessionContentStore;
}

const RECORD_CONTENT_ID = "eve.record-content";
const OUT_OF_LINE_RECORD_BYTES = SESSION_LIMITS.recordBytes / 16;
const TRANSFER_KEYS = ["history", "sessionState", "serializedContext"] as const;

export async function keepSessionRecord(
  contents: Omit<SessionRecordContents, "version">,
  out?: SessionRecordContent,
): Promise<SessionRecord> {
  if (out === undefined) return sealSessionRecord(contents);
  const transfer: Record<string, unknown> = { ...contents.transfer };
  for (const key of TRANSFER_KEYS) transfer[key] = await outOfLine(contents.transfer[key], out);
  return sealSessionRecord({
    ...contents,
    open: (await outOfLine(contents.open, out)) as OpenTurn | undefined,
    transfer: transfer as SessionTransferState,
  });
}

export async function restoreSessionRecord(
  record: SessionRecord,
  out?: SessionRecordContent,
): Promise<SessionRecordContents> {
  const contents = openSessionRecord(record);
  const transfer: Record<string, unknown> = { ...contents.transfer };
  for (const key of TRANSFER_KEYS) transfer[key] = await inline(transfer[key], out);
  return {
    ...contents,
    open: (await inline(contents.open, out)) as OpenTurn | undefined,
    transfer: transfer as SessionTransferState,
  };
}

async function outOfLine(value: unknown, out: SessionRecordContent): Promise<unknown> {
  if (value === undefined) return value;
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength <= OUT_OF_LINE_RECORD_BYTES) return value;
  return { [RECORD_CONTENT_ID]: await out.content.put(out.sessionId, bytes) };
}

async function inline(value: unknown, out: SessionRecordContent | undefined): Promise<unknown> {
  const id = (value as { readonly [RECORD_CONTENT_ID]?: unknown } | undefined)?.[RECORD_CONTENT_ID];
  if (typeof id !== "string") return value;
  if (out === undefined) {
    throw new Error(
      "This session's record keeps part of its state in a content store, and the engine gave runSession() none. Give runSession() the content store that kept the record.",
    );
  }
  return JSON.parse(new TextDecoder().decode(await out.content.get(out.sessionId, id)));
}
