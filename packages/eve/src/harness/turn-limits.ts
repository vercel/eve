/**
 * Per-turn model request allowance and deadline. The count and the turn's start live on
 * `session.state`, keyed by turn id, so they carry across the turn's steps and a new turn starts
 * fresh without a reset path.
 */
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const TURN_REQUESTS_STATE_KEY = "eve.harness.turnRequests";

/** The authored per-turn limits; absent fields leave that axis uncapped. */
export interface TurnLimits {
  readonly maxModelRequestsPerTurn?: number;
  readonly turnTimeoutMs?: number;
}

interface TurnRequestsState {
  readonly requests: number;
  readonly startedAt: number;
  readonly turnId: string;
}

/** A turn spent its model request allowance or passed its deadline. */
export class TurnLimitReachedError extends Error {
  readonly code = "TURN_LIMIT_REACHED";
  readonly details: {
    readonly kind: "model-requests" | "turn-deadline";
    readonly limit: number;
  };

  constructor(details: TurnLimitReachedError["details"]) {
    super(
      details.kind === "model-requests"
        ? `This turn reached its limit of ${details.limit} model requests.`
        : `This turn passed its ${details.limit}ms deadline.`,
    );
    this.name = "TurnLimitReachedError";
    this.details = details;
  }
}

/** Maps authored limits, where `false` means uncapped, onto {@link TurnLimits}. */
export function resolveTurnLimits(
  authored:
    | {
        readonly maxModelRequestsPerTurn?: number | false;
        readonly turnTimeoutMs?: number | false;
      }
    | undefined,
): TurnLimits | undefined {
  const limits: { maxModelRequestsPerTurn?: number; turnTimeoutMs?: number } = {};
  if (typeof authored?.maxModelRequestsPerTurn === "number") {
    limits.maxModelRequestsPerTurn = authored.maxModelRequestsPerTurn;
  }
  if (typeof authored?.turnTimeoutMs === "number") limits.turnTimeoutMs = authored.turnTimeoutMs;
  return Object.keys(limits).length === 0 ? undefined : limits;
}

function readTurnRequests(
  state: SessionStateMap | undefined,
  turnId: string,
  now: number,
): TurnRequestsState {
  const stored = state?.[TURN_REQUESTS_STATE_KEY] as TurnRequestsState | undefined;
  return stored?.turnId === turnId ? stored : { requests: 0, startedAt: now, turnId };
}

/**
 * Charges one model request to the turn before it is sent, or throws
 * {@link TurnLimitReachedError} when the allowance is spent or the deadline passed.
 */
export function chargeModelRequest<T extends Pick<HarnessSession, "state">>(
  session: T,
  input: {
    readonly limits: TurnLimits | undefined;
    readonly turnId: string;
    readonly now?: number;
  },
): T {
  if (input.limits === undefined) return session;
  const now = input.now ?? Date.now();
  const current = readTurnRequests(session.state, input.turnId, now);
  const { maxModelRequestsPerTurn, turnTimeoutMs } = input.limits;
  if (turnTimeoutMs !== undefined && now - current.startedAt >= turnTimeoutMs) {
    throw new TurnLimitReachedError({ kind: "turn-deadline", limit: turnTimeoutMs });
  }
  if (maxModelRequestsPerTurn !== undefined && current.requests >= maxModelRequestsPerTurn) {
    throw new TurnLimitReachedError({ kind: "model-requests", limit: maxModelRequestsPerTurn });
  }
  return {
    ...session,
    state: {
      ...session.state,
      [TURN_REQUESTS_STATE_KEY]: { ...current, requests: current.requests + 1 },
    },
  };
}

/** Milliseconds left before the turn's deadline, or `undefined` without one. */
export function remainingTurnMs(
  session: Pick<HarnessSession, "state">,
  input: {
    readonly limits: TurnLimits | undefined;
    readonly turnId: string;
    readonly now?: number;
  },
): number | undefined {
  const timeout = input.limits?.turnTimeoutMs;
  if (timeout === undefined) return undefined;
  const now = input.now ?? Date.now();
  const { startedAt } = readTurnRequests(session.state, input.turnId, now);
  return Math.max(0, startedAt + timeout - now);
}
