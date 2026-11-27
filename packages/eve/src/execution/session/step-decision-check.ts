import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { activeTurn, waiting } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

export function stepDisagreement(result: DurableStepResult, view: SessionView): string | undefined {
  if (result.action === "done" || result.action === "cancelled") return undefined;
  const turnId = activeTurn(view)?.turnId;
  const currentWaiting = turnId === undefined ? undefined : waiting(view, turnId);
  const tables = turnId === undefined ? "no-turn" : (currentWaiting?.on ?? "session");
  const step =
    result.action === "paused"
      ? result.on === "interaction"
        ? "interaction"
        : "work"
      : result.action;
  const continuingAlongsideTasks =
    step === "continue" &&
    currentWaiting?.on === "work" &&
    currentWaiting.calls.length > 0 &&
    currentWaiting.calls.every(
      (call) => call.taskId !== undefined && call.capability.name !== "eve__task_wait",
    );
  const agrees =
    (step === "interaction" && tables === "interaction") ||
    (step === "work" && tables === "work") ||
    (step === "continue" && (tables === "session" || continuingAlongsideTasks)) ||
    (step === "parked" && (tables === "no-turn" || tables === "interaction"));
  if (agrees) return undefined;
  if (
    result.action === "paused" &&
    result.on === "calls" &&
    (result.dispatch || result.taskToolCalls.length > 0) &&
    tables === "session"
  )
    return "dispatch-deferred";
  return `${step}-but-${tables}`;
}
