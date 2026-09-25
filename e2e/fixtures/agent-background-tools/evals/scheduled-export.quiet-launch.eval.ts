import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

const FINAL = "SCHEDULED-EXPORT-DONE";

/**
 * A schedule-launched turn that dispatches a background task sends no launch
 * acknowledgement even when it runs with a user principal: durable schedule
 * provenance keeps conditional delivery, so the
 * launching turn completes with a null message, and only the settled wake delivers a report.
 */
export default defineEval({
  description:
    "Quiet scheduled launch: a schedule-dispatched background export acknowledges nothing and reports once on completion.",

  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.skip("Target has no dev routes; schedule dispatch is dev-only.");
    }

    // Scheduled root dispatch: the schedule, not an inbound turn, creates the session.
    const dispatch = await t.target.dispatchSchedule("scheduled-export");
    await t.require(dispatch.scheduleId, equals("scheduled-export"));
    await t.require(
      dispatch.sessionIds,
      satisfies(
        (sessionIds: readonly string[]) => sessionIds.length > 0,
        "schedule started a session",
      ),
    );
    const sessionId = dispatch.sessionIds[0]!;

    // The launching turn: dispatches the background export, then delivers
    // nothing — no launch acknowledgement.
    const session = await t.target.attachSession(sessionId);
    session.succeeded();
    session.calledTool("export");
    session.event("session.waiting");
    session.event("message.completed", {
      data: (data) => data.finishReason !== "tool-calls" && data.message === null,
      count: 1,
    });
    session.notEvent("message.completed", {
      data: (data) => data.finishReason !== "tool-calls" && data.message !== null,
    });

    const doneLive = t.target.watchTurn(sessionId, {
      startIndex: requireStreamIndex(session, "completion wait"),
    });
    const doneTurn = await doneLive.result();
    doneTurn.expectOk();
    doneTurn.messageIncludes(FINAL);
    doneTurn.event("message.completed", {
      data: (data) => data.finishReason !== "tool-calls" && data.message !== null,
      count: 1,
    });
    await t.require(
      doneTurn.events,
      satisfies(
        (events: typeof doneTurn.events) =>
          events.every(
            (event) =>
              event.type !== "message.received" || event.data.kind === "execution.background_task",
          ),
        "any observable task wake retains framework provenance",
      ),
    );

    // Replay both durable turns. Only the late report survives as assistant output.
    const replayedLaunch = await t.target.attachSession(sessionId);
    const replayedDoneLive = t.target.watchTurn(sessionId, {
      startIndex: requireStreamIndex(replayedLaunch, "replayed completion"),
    });
    await replayedDoneLive.result();
    const replayedEvents = [...replayedLaunch.events, ...replayedDoneLive.events];
    await t.require(
      replayedEvents,
      satisfies(
        (events: typeof replayedEvents) =>
          events.filter(
            (event) =>
              event.type === "message.completed" &&
              event.data.message !== null &&
              JSON.stringify(event.data.message).includes(FINAL),
          ).length === 1,
        "replay retains one final export report",
      ),
    );
    t.noFailedActions();
    t.succeeded();
  },
});

function requireStreamIndex(
  session: { readonly state?: { readonly streamIndex?: number } },
  operation: string,
): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error(`${operation} has no session stream index.`);
  return streamIndex;
}
