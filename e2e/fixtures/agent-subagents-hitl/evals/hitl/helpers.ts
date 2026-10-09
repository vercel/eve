import type { EveEvalContext, EveEvalSession, EveEvalTurn, InputRequest } from "eve/evals";

/**
 * Follows the parent session, turn by turn, until a child's request matching
 * `toolName` is pending on it. A child asks after its own model call, so the
 * request may land a turn or two after the delegation.
 */
export async function waitForRelayed(
  t: EveEvalContext,
  initial: EveEvalSession,
  toolName: string,
): Promise<{ readonly request: InputRequest; readonly session: EveEvalSession }> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const request = session.pendingInputRequests.find(
      (pending) => pending.action.toolName === toolName,
    );
    if (request !== undefined) return { request, session };
    session = (await next(t, session)).session;
  }
  throw new Error(`No relayed ${toolName} request reached the parent after five turns.`);
}

/** Follows the parent until a turn's reply contains `marker`. */
export async function waitForReply(
  t: EveEvalContext,
  initial: EveEvalSession,
  marker: string,
): Promise<EveEvalTurn> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const turn = await next(t, session);
    if (turn.message?.includes(marker) === true) return turn;
    session = turn.session;
  }
  throw new Error(`No parent reply contained ${marker} after five turns.`);
}

/** The parent's events from its current cursor to the next turn boundary. */
export function next(t: EveEvalContext, session: EveEvalSession): Promise<EveEvalTurn> {
  return t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex }).result();
}
