import type { EveEvalContext, EveEvalTurn } from "eve/evals";

/** Stream events of one eval session, in order. */
type SessionEvents = EveEvalTurn["events"];

/** The `task.started` data of every call to one agent. */
export function taskStarts(events: SessionEvents, name: string) {
  return events.flatMap((event) =>
    event.type === "task.started" && event.data.name === name ? [event.data] : [],
  );
}

/**
 * The agent ids from receipts the turn's calls to one agent returned. A
 * detached call's `task.started` can land after its turn ends, so the
 * receipt is the turn's own evidence of the call.
 */
export function receiptTaskIds(turn: EveEvalTurn, name: string): readonly string[] {
  return turn.toolCalls.flatMap((call) => {
    if (call.name !== name) return [];
    const output = call.output as { readonly status?: unknown; readonly taskId?: unknown } | null;
    return output?.status === "working" && typeof output.taskId === "string" ? [output.taskId] : [];
  });
}

/** The task ids each `task.result` message delivered, one entry per message. */
export function taskResultDeliveries(events: SessionEvents): readonly (readonly string[])[] {
  return events.flatMap((event) =>
    event.type === "message.received" && event.data.kind === "task.result"
      ? [event.data.taskIds ?? []]
      : [],
  );
}

/**
 * Waits for the session's next turn segment after `turn`: the rest of a
 * held turn, which delivers a detached agent's answer after the turn's
 * waiting boundary, or the next turn. Events the turn already published are
 * replayed from the session cursor.
 */
export async function watchNextTurn(t: EveEvalContext, turn: EveEvalTurn): Promise<EveEvalTurn> {
  return await t.target
    .watchTurn(turn.sessionId, { startIndex: turn.session.state.streamIndex })
    .result();
}

/**
 * Watches the turns after `turn` until the turns watched so far satisfy
 * `done`, for at most `maxTurns` turns, and returns every turn it watched.
 */
export async function watchTurnsUntil(
  t: EveEvalContext,
  turn: EveEvalTurn,
  done: (watched: readonly EveEvalTurn[]) => boolean,
  maxTurns: number,
): Promise<readonly EveEvalTurn[]> {
  const watched: EveEvalTurn[] = [];
  let last = turn;
  while (watched.length < maxTurns) {
    last = await watchNextTurn(t, last);
    watched.push(last);
    if (done(watched)) break;
  }
  return watched;
}
