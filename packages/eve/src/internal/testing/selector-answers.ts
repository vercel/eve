import {
  activeTurn,
  activity,
  callState,
  failure,
  idle,
  openInteractions,
  openWork,
  queue,
  reply,
  tasks,
  waiting,
} from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

/**
 * What readers ask of a view, for comparing two retentions: the selectors an operational view, a
 * hook's `ctx.view`, promises to answer as a complete one does, about what it holds. The list is
 * the one `docs/guides/hooks.md` publishes. Pass the operational view as `held` to ask a complete
 * view about the same rows.
 */
export function selectorAnswers(view: SessionView, held: SessionView = view) {
  const ids = (rows: readonly object[], key: string) =>
    rows.map((row) => (row as Record<string, unknown>)[key]);
  const per = <T>(keys: readonly string[], read: (key: string) => T) =>
    Object.fromEntries(keys.map((key) => [key, read(key)]));
  const turnId = activeTurn(view)?.turnId;
  const latest = view.session.latestTurnId;
  const waits = turnId === undefined ? undefined : waiting(view, turnId);
  const doing = activity(view);
  return {
    activity: {
      kind: doing.kind,
      ...("interactions" in doing && { interactions: ids(doing.interactions, "interactionId") }),
      ...("tasks" in doing && { tasks: ids(doing.tasks, "taskId") }),
      ...("names" in doing && { names: doing.names }),
    },
    callInteractions: per(Object.keys(held.calls), (callId) =>
      ids(openInteractions(view, { about: { callId } }), "interactionId"),
    ),
    callState: per(Object.keys(held.calls), (callId) => callState(view, callId)),
    failure: latest === undefined ? undefined : failure(view, latest),
    idle: idle(view),
    open: Object.values(openWork(view, { session: true })).map((rows) => rows.length),
    openInteractions: ids(openInteractions(view), "interactionId"),
    queue: ids(queue(view), "deliveryId"),
    reply: latest === undefined ? undefined : ids(reply(view, latest), "partId"),
    tasks: {
      idle: ids(tasks(view, { status: "idle" }), "taskId"),
      working: ids(tasks(view, { status: "working" }), "taskId"),
    },
    turnId,
    waiting:
      waits === undefined
        ? undefined
        : waits.on === "interaction"
          ? { interaction: ids(waits.interactions, "interactionId") }
          : waits.on === "work"
            ? { calls: ids(waits.calls, "callId"), tasks: ids(waits.tasks, "taskId") }
            : "session",
  };
}
