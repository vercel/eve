import { openSessionRecord, type SessionRecord } from "#execution/session/record.js";
import { readStampedSessionCodeHash } from "#internal/application/stamped-package-version.js";

/**
 * Returns the hash of the session code of this eve build, or `undefined` when eve runs from
 * source that has no stamp. A session record can replay only on the same session code.
 */
export function sessionCodeHash(): string | undefined {
  return readStampedSessionCodeHash();
}

/**
 * The error of `runSession()` and `StoreDurable.run()` for a record that another session code
 * wrote. The run changes nothing. Park the session until a deployment with the record's session
 * code runs it, or retire the session.
 */
export class SessionCodeMismatchError extends Error {
  /** The ID of the session. */
  readonly sessionId: string;
  /** The session code that wrote the record, or `undefined` for unstamped source. */
  readonly recordCode: string | undefined;
  /** The session code of this deployment, or `undefined` for unstamped source. */
  readonly runningCode: string | undefined;

  constructor(sessionId: string, recordCode: string | undefined, runningCode: string | undefined) {
    super(
      `The record of session "${sessionId}" is from session code ${shown(recordCode)}, and this deployment runs session code ${shown(runningCode)}. Park the session until a deployment with session code ${shown(recordCode)} runs it, or retire the session.`,
    );
    this.name = "SessionCodeMismatchError";
    this.sessionId = sessionId;
    this.recordCode = recordCode;
    this.runningCode = runningCode;
  }

  /** Returns `true` for a `SessionCodeMismatchError`, also from another copy of eve. */
  static is(error: unknown): error is SessionCodeMismatchError {
    return (
      error instanceof SessionCodeMismatchError ||
      (error instanceof Error && error.name === "SessionCodeMismatchError")
    );
  }
}

export function assertRecordSessionCode(sessionId: string, record: SessionRecord): void {
  const recordCode = openSessionRecord(record).sessionCode;
  const runningCode = sessionCodeHash();
  if (recordCode !== runningCode)
    throw new SessionCodeMismatchError(sessionId, recordCode, runningCode);
}

function shown(code: string | undefined): string {
  return code === undefined ? "unstamped source" : `"${code}"`;
}
