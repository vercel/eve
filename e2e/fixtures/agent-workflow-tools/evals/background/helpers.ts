import type { EveEvalContext, EveEvalLiveTurn, EveEvalTurn } from "eve/evals";

/** Stream events of one eval turn or session, in order. */
type Events = EveEvalTurn["events"];

/** The task IDs each `task.result` message delivered, one entry per message. */
export function taskResultDeliveries(events: Events): readonly (readonly string[])[] {
  return events.flatMap((event) =>
    event.type === "message.received" && event.data.kind === "task.result"
      ? [event.data.taskIds ?? []]
      : [],
  );
}

/** Task IDs of the calls to one tool that returned a background receipt. */
export function receiptTaskIds(turn: EveEvalTurn, toolName: string): readonly string[] {
  return turn.toolCalls.flatMap((call) => {
    if (call.name !== toolName) return [];
    const output = call.output as { readonly status?: unknown; readonly taskId?: unknown } | null;
    return output?.status === "working" && typeof output.taskId === "string" ? [output.taskId] : [];
  });
}

/** Task IDs of every `task.detached` event with the given reason. */
export function detachedTaskIds(events: Events, reason: "steer" | "timeout"): readonly string[] {
  return events.flatMap((event) =>
    event.type === "task.detached" && event.data.reason === reason ? [event.data.taskId] : [],
  );
}

/** Task IDs of every `task.started` event for one tool. */
export function startedTaskIds(events: Events, name: string): readonly string[] {
  return events.flatMap((event) =>
    event.type === "task.started" && event.data.name === name ? [event.data.taskId] : [],
  );
}

/**
 * Waits for the session's next turn after `turn`, such as the result turn
 * that delivers a background task's result.
 */
export async function watchNextTurn(t: EveEvalContext, turn: EveEvalTurn): Promise<EveEvalTurn> {
  return await t.target
    .watchTurn(turn.sessionId, { startIndex: turn.session.state.streamIndex })
    .result();
}

/** Waits until the live turn has started `count` tasks for one tool. */
export async function waitForStarts(
  t: EveEvalContext,
  live: EveEvalLiveTurn,
  name: string,
  count: number,
): Promise<void> {
  await live.waitForEvent("task.started", { data: { name } });
  for (let waited = 0; waited < 20_000; waited += 250) {
    if (startedTaskIds(live.events, name).length >= count) return;
    await t.sleep(250);
  }
  throw new Error(`Expected ${count} ${name} tasks to start.`);
}
