import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { activeTurn, waiting } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

/**
 * How a turn step's decision disagrees with what the tables say the turn waits on, if it does. A
 * step that pauses on calls only requested, which the next durable step dispatches or, for task
 * tool calls, answers, is the one known disagreement, `dispatch-deferred`: the tables say the
 * session has work, and it does.
 */
export function stepDisagreement(result: DurableStepResult, view: SessionView): string | undefined {
  if (result.action === "done" || result.action === "cancelled") return undefined;
  const turnId = activeTurn(view)?.turnId;
  const tables = turnId === undefined ? "no-turn" : (waiting(view, turnId)?.on ?? "session");
  const step =
    result.action === "paused"
      ? result.on === "interaction"
        ? "interaction"
        : "work"
      : result.action;
  const agrees =
    (step === "interaction" && tables === "interaction") ||
    (step === "work" && tables === "work") ||
    (step === "continue" && tables === "session") ||
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
