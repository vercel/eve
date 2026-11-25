import { sessionView } from "#harness/session-machine/commit.js";
import { programsOf } from "#harness/session-machine/programs.js";
import { runtimeWait, ownOpenRequestIds } from "#harness/session-machine/view.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { openSignIns } from "#protocol/session-projection/reader.js";

export type TurnPause =
  | {
      readonly on: "interaction";
      readonly attemptIds: readonly string[];
      readonly requestIds: readonly string[];
    }
  | { readonly on: "tasks"; readonly taskIds: readonly string[] }
  | {
      readonly on: "calls";
      readonly callIds: readonly string[];
      readonly dispatch: boolean;
      readonly pausedAtMs?: number;
      readonly taskToolCalls: readonly TaskToolCall[];
    };

export function pausedOnInteraction(
  session: HarnessSession,
  projection: SessionProjection,
): TurnPause {
  const challenges = sessionView(projection, session.state).signIns;
  return {
    attemptIds: challenges.flatMap((challenge) =>
      challenge.attemptId === undefined ? [] : [challenge.attemptId],
    ),
    on: "interaction",
    requestIds: [...ownOpenRequestIds(sessionView(projection, session.state))],
  };
}

export function pausedOnTasks(taskIds: readonly string[]): TurnPause {
  return { on: "tasks", taskIds };
}

export function pausedOnCalls(session: HarnessSession): TurnPause | undefined {
  const waiting = runtimeWait(session.state);
  if (waiting === undefined) return undefined;
  const hasTaskWait = waiting.taskToolCalls.some((call) => call.kind === TASK_WAIT_TOOL_NAME);
  return {
    callIds: waiting.callIds,
    dispatch: waiting.tasks.length > 0,
    on: "calls",
    ...(hasTaskWait && { pausedAtMs: Date.now() }),
    taskToolCalls: waiting.taskToolCalls,
  };
}

export function waitsOnAnything(session: HarnessSession, projection: SessionProjection): boolean {
  const view = sessionView(projection, session.state);
  return (
    openSignIns(projection.view).length > 0 ||
    ownOpenRequestIds(view).size > 0 ||
    (runtimeWait(session.state)?.callIds.length ?? 0) > 0 ||
    programsOf(view.turn).length > 0
  );
}
