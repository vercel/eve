import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

// Token returned by agent/tools/record-heartbeat.ts; mirrored here because the
// agent tree compiles independently of the eval tree.
const HEARTBEAT_TOKEN = "schedule-heartbeat-ok-P2N";

/**
 * Exercises the schedule dispatch path end-to-end: fire the `heartbeat`
 * markdown schedule through the dev dispatch route, then attach to the
 * session it started and prove the cron handler ran the agent — the agent
 * called `record-heartbeat`, the result carried the token, and nothing failed.
 *
 * The dispatch route is dev-only, so this is a no-op on deployed (Vercel)
 * targets where `devRoutes` is false; the production cron path becomes a real
 * Vercel Cron Job that cannot be triggered on demand from an eval.
 */
export default defineEval({
  description: "Schedule dispatch: firing a markdown schedule runs the agent and its tool.",

  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.log("Target has no dev routes (deployed build); schedule dispatch is dev-only. Skipping.");
      return;
    }

    const dispatch = await t.target.dispatchSchedule("heartbeat");
    if (dispatch.scheduleId !== "heartbeat") {
      throw new Error(
        `Expected scheduleId "heartbeat"; got ${JSON.stringify(dispatch.scheduleId)}.`,
      );
    }
    const [sessionId] = dispatch.sessionIds;
    if (sessionId === undefined) {
      throw new Error("Schedule dispatch returned no session ids.");
    }
    t.log(`heartbeat dispatched session ${sessionId}`);

    // Replay the dispatched session's stream from durable storage and drive it
    // to a turn boundary.
    const session = await t.target.attachSession(sessionId);

    const failures = session.events.filter(
      (event) =>
        event.type === "session.failed" ||
        event.type === "turn.failed" ||
        event.type === "step.failed",
    );
    if (failures.length > 0) {
      throw new Error(`Dispatched schedule session failed: ${formatTypes(failures)}`);
    }

    const heartbeat = heartbeatToolResults(session.events);
    if (heartbeat.length === 0) {
      throw new Error(
        `Expected at least one record-heartbeat result in the dispatched session; saw event types ${formatTypes(session.events)}.`,
      );
    }
    if (!heartbeat.some((output) => output.includes(HEARTBEAT_TOKEN))) {
      throw new Error(
        `record-heartbeat ran but no result carried the token ${HEARTBEAT_TOKEN}: ${JSON.stringify(heartbeat)}`,
      );
    }

    t.didNotFail();
    t.completed();
  },
});

function heartbeatToolResults(events: readonly HandleMessageStreamEvent[]): string[] {
  const results: string[] = [];
  for (const event of events) {
    if (event.type !== "action.result") continue;
    const result = event.data.result;
    if (result.kind !== "tool-result" || result.toolName !== "record-heartbeat") continue;
    results.push(JSON.stringify(result.output ?? ""));
  }
  return results;
}

function formatTypes(events: readonly HandleMessageStreamEvent[]): string {
  return JSON.stringify(events.map((event) => event.type));
}
