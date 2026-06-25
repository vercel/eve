import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

/** Proves an every-minute polling schedule can leave its target channel silent. */
export default defineEval({
  description: "Conditional channel delivery: an empty scheduled alert check sends no message.",

  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.skip("Target has no dev routes; schedule dispatch is dev-only.");
    }

    const dispatch = await t.target.dispatchSchedule("quiet-alerts");
    await t.require(dispatch.scheduleId, equals("quiet-alerts"));
    await t.require(
      dispatch.sessionIds,
      satisfies(
        (sessionIds: readonly string[]) => sessionIds.length > 0,
        "schedule started a session",
      ),
    );
    const sessionId = dispatch.sessionIds[0]!;

    const session = await t.target.attachSession(sessionId);
    session.succeeded();
    session.calledTool("check-alerts");
    session.event("session.waiting");
    session.event("message.completed", {
      data: (data) => data.finishReason !== "tool-calls" && data.message === null,
      count: 1,
    });
    session.notEvent("message.completed", {
      data: (data) => data.finishReason !== "tool-calls" && data.message !== null,
    });

    t.succeeded();
  },
});
