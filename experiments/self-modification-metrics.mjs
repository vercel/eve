import {
  captureSessions,
  selectEvents,
  unavailable,
} from "../scripts/eval-experiments/measurements/events.mjs";
import {
  completedTurns,
  delegatedSessions,
  parentTurnStarts,
} from "../scripts/eval-experiments/measurements/lifecycle.mjs";
import {
  elapsedTime,
  totalToolCalls,
  totalTurnDuration,
} from "../scripts/eval-experiments/measurements/metrics.mjs";

/** @satisfies {import('../scripts/eval-experiments/types.ts').MeasurementBundle} */
export const selfModificationMetrics = {
  version: 3,
  metrics: {
    parentTurnToFinalChildCompletion: { unit: "ms", direction: "lower" },
    totalChildDuration: { unit: "ms", direction: "lower" },
    toolCalls: { unit: "count", direction: "neutral" },
  },
  derive(captured) {
    const capture = captureSessions(captured.result.sessions);
    if (!capture) return unavailableMetrics("missing-session-capture");

    const calls = selectEvents(capture.events, "subagent.called", {
      name: "self-modification__agent",
    });
    const children = delegatedSessions(capture, calls);
    if (children.status === "unavailable") return unavailableMetrics(children.reason);

    const childTurns = completedTurns(capture, children.sessionIds, { subject: "child-turn" });
    if (childTurns.status === "unavailable") return unavailableMetrics(childTurns.reason);

    const parentStarts = parentTurnStarts(capture, calls);
    const parentTurnToFinalChildCompletion =
      parentStarts.status === "unavailable"
        ? parentStarts
        : elapsedTime(
            capture,
            parentStarts.events,
            childTurns.turns.map((turn) => turn.completed),
            {
              evidence: calls,
              missingReason: "missing-parent-or-child-timestamp",
            },
          );
    const totalChildDuration = totalTurnDuration(capture, childTurns.turns, {
      missingReason: "missing-child-timestamp",
    });

    return {
      parentTurnToFinalChildCompletion,
      totalChildDuration,
      // Only count calls when the child turns have valid duration evidence.
      toolCalls:
        totalChildDuration.status === "measured"
          ? totalToolCalls(capture, childTurns.turns)
          : totalChildDuration,
    };
  },
};

function unavailableMetrics(reason) {
  return Object.fromEntries(
    Object.keys(selfModificationMetrics.metrics).map((name) => [name, unavailable(reason)]),
  );
}
