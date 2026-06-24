import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

/** Proves an every-minute polling schedule can leave its target channel silent. */
export default defineEval({
  description: "Conditional channel delivery: an empty scheduled alert check sends no message.",

  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.log("Target has no dev routes (deployed build); schedule dispatch is dev-only. Skipping.");
      return;
    }

    const dispatch = await t.target.dispatchSchedule("quiet-alerts");
    if (dispatch.scheduleId !== "quiet-alerts") {
      throw new Error(
        `Expected quiet-alerts dispatch, got ${JSON.stringify(dispatch.scheduleId)}.`,
      );
    }
    const [sessionId] = dispatch.sessionIds;
    if (sessionId === undefined) {
      throw new Error("Quiet schedule dispatch returned no session ids.");
    }

    const session = await t.target.attachSession(sessionId);
    const failures = session.events.filter(isFailure);
    if (failures.length > 0) {
      throw new Error(`Quiet schedule session failed: ${formatTypes(failures)}`);
    }

    const checkedAlerts = session.events.some(
      (event) =>
        event.type === "action.result" &&
        event.data.result.kind === "tool-result" &&
        event.data.result.toolName === "check-alerts",
    );
    if (!checkedAlerts) {
      throw new Error(`Expected check-alerts to run; saw ${formatTypes(session.events)}.`);
    }

    if (!session.events.some((event) => event.type === "session.waiting")) {
      throw new Error(
        `Expected the target channel session to reach its waiting boundary; saw ${formatTypes(session.events)}.`,
      );
    }

    const terminalMessages = session.events.flatMap((event) =>
      event.type === "message.completed" && event.data.finishReason !== "tool-calls"
        ? [event.data.message]
        : [],
    );
    if (!terminalMessages.includes(null)) {
      throw new Error(
        `Expected an empty-delivery completion; saw ${JSON.stringify(terminalMessages)}.`,
      );
    }
    const delivered = terminalMessages.filter((message) => message !== null);
    if (delivered.length > 0) {
      throw new Error(
        `Expected empty delivery, but the schedule produced ${JSON.stringify(delivered)}.`,
      );
    }

    t.didNotFail();
    t.completed();
  },
});

function isFailure(event: HandleMessageStreamEvent): boolean {
  return (
    event.type === "session.failed" || event.type === "turn.failed" || event.type === "step.failed"
  );
}

function formatTypes(events: readonly HandleMessageStreamEvent[]): string {
  return JSON.stringify(events.map((event) => event.type));
}
