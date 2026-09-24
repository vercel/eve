import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

const FINAL = "SCHEDULED-REMOTE-FINAL SCHEDULED-REMOTE-CHILD-RESULT";

/**
 * The schedule creates a root session, so no TurnCaller exists. This E2E observes
 * that boundary through the channel stream; TurnCaller absence itself has no event.
 */
export default defineEval({
  description:
    "A scheduled root waits for its remote-agent call and delivers the result once, in the same turn.",
  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.skip("Target has no dev routes; schedule dispatch is dev-only.");
    }

    // Scheduled root dispatch: the schedule, not an inbound turn, creates the session.
    const dispatch = await t.target.dispatchSchedule("scheduled-remote");
    await t.require(dispatch.scheduleId, equals("scheduled-remote"));
    await t.require(
      dispatch.sessionIds,
      satisfies((ids: readonly string[]) => ids.length > 0, "schedule started a root session"),
    );
    const sessionId = dispatch.sessionIds[0]!;

    // The remote-agent call resolves inside the scheduled turn, and the reply uses its result.
    const launch = await t.target.attachSession(sessionId);
    launch.succeeded();
    launch.calledSubagent("remote-loopback", {
      output: /SCHEDULED-REMOTE-CHILD-RESULT/,
      status: "completed",
      count: 1,
    });
    launch.event("subagent.completed", {
      data: { subagentName: "remote-loopback" },
      count: 1,
    });
    launch.messageIncludes(FINAL);

    // Exactly one final non-null delivery crosses the channel boundary.
    await t.require(
      launch.events,
      satisfies(
        (events: typeof launch.events) =>
          events.filter(
            (event) =>
              event.type === "message.completed" &&
              event.data.finishReason !== "tool-calls" &&
              event.data.message !== null,
          ).length === 1,
        "exactly one final non-null reply crosses the channel boundary",
      ),
    );
    t.noFailedActions();
    t.succeeded();
  },
});
