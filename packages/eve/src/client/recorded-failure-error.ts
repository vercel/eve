import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import { failure } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { EveError } from "#shared/eve-error.js";

/**
 * A turn that failed on the server, read from the session's events. `message` is the recorded
 * failure's message, and `name` is its recorded code, such as `MODEL_CALL_FAILED`. `info` is the
 * full recorded `ErrorInfo`: its `code`, and its `name`, `id` (the support ID), and `hint` when
 * present. Narrow with `TurnFailedError.is(error)`.
 */
export class TurnFailedError extends EveError {
  static override readonly errorName = "TurnFailedError";
  declare readonly code: "turn_failed";
  /** The failed turn's ID. */
  readonly turnId: string;
  /** The failure the server recorded. */
  readonly info: ErrorInfo;

  constructor(turnId: string, info: ErrorInfo) {
    super("turn_failed", info.message);
    this.name = info.code;
    this.turnId = turnId;
    this.info = info;
  }
}

/**
 * A session that failed on the server, read from the session's events. `message` is the
 * recorded failure's message, and `name` is its recorded code, such as `SESSION_FAILED`. `info` is
 * the full recorded `ErrorInfo`: its `code`, and its `name`, `id` (the support ID), and `hint` when
 * present. Narrow with `SessionFailedError.is(error)`.
 */
export class SessionFailedError extends EveError {
  static override readonly errorName = "SessionFailedError";
  declare readonly code: "session_failed";
  /** The failure the server recorded. */
  readonly info: ErrorInfo;

  constructor(info: ErrorInfo) {
    super("session_failed", info.message);
    this.name = info.code;
    this.info = info;
  }
}

export function recordedFailure(
  view: SessionView,
  turnId: string | undefined,
): TurnFailedError | SessionFailedError | undefined {
  const info = failure(view, turnId);
  if (info === undefined) return undefined;
  const turnFailed = turnId !== undefined && view.turns[turnId]?.outcome === "failed";
  return turnFailed ? new TurnFailedError(turnId, info) : new SessionFailedError(info);
}
