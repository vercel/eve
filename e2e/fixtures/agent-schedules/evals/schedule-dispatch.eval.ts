import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

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
      t.skip("Target has no dev routes; schedule dispatch is dev-only.");
    }

    const dispatch = await t.target.dispatchSchedule("heartbeat");
    await t.require(dispatch.scheduleId, equals("heartbeat"));
    await t.require(
      dispatch.sessionIds,
      satisfies(
        (sessionIds: readonly string[]) => sessionIds.length > 0,
        "schedule started a session",
      ),
    );
    const sessionId = dispatch.sessionIds[0]!;
    t.log(`heartbeat dispatched session ${sessionId}`);

    // Replay the dispatched session's stream from durable storage and drive it
    // to a turn boundary.
    const session = await t.target.attachSession(sessionId);

    session.succeeded();
    session.calledTool("record-heartbeat", {
      output: new RegExp(HEARTBEAT_TOKEN),
    });

    t.succeeded();
  },
});
