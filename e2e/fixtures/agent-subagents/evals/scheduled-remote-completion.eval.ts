import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

const FINAL = "SCHEDULED-REMOTE-FINAL SCHEDULED-REMOTE-CHILD-RESULT";
const PREMATURE =
  "Weekly report could not be completed before delivery because the analytics query did not return a result.";

/**
 * The schedule creates a root session, so no TurnCaller exists. This E2E observes
 * that boundary through the channel stream; TurnCaller absence itself has no event.
 */
export default defineEval({
  description:
    "A scheduled root suppresses its nonempty remote-agent launch fallback and delivers the late result exactly once.",
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

    // Initiating turn: withhold the deliberate nonempty premature fallback from
    // both the event stream and the channel.
    const launch = await t.target.attachSession(sessionId);
    launch.succeeded();
    launch.calledTool("remote-loopback");
    launch.event("subagent.admitted", {
      data: (data) => data.subagentName === "remote-loopback" && data.backgroundTask !== undefined,
      count: 1,
    });
    launch.event("message.completed", {
      data: (data) => data.finishReason !== "tool-calls" && data.message === null,
      count: 1,
    });
    launch.notEvent("message.completed", {
      data: (data) => data.finishReason !== "tool-calls" && data.message !== null,
    });
    await t.require(
      launch.events,
      satisfies(
        (events: typeof launch.events) => !JSON.stringify(events).includes(PREMATURE),
        "the adapter and channel suppress the premature fallback",
      ),
    );

    // Agent receives background task result after turn ended.
    if (launch.state === undefined) throw new Error("scheduled launch has no stream cursor");
    const completedLive = t.target.watchTurn(sessionId, {
      startIndex: launch.state.streamIndex,
    });
    const completed = await completedLive.result();
    completed.expectOk();
    completed.messageIncludes(FINAL);
    await t.require(
      completed.events,
      satisfies(
        (events: typeof completed.events) =>
          events.some(
            (event) =>
              event.type === "message.received" &&
              messageText(event.data.message).includes("is completed") &&
              messageText(event.data.message).includes("SCHEDULED-REMOTE-CHILD-RESULT"),
          ),
        "the final reply follows the late remote-agent result",
      ),
    );
    completed.event("message.completed", {
      data: (data) =>
        data.finishReason !== "tool-calls" &&
        data.message !== null &&
        JSON.stringify(data.message).includes(FINAL),
      count: 1,
    });

    // Replay both durable turns. The fallback never becomes assistant output,
    // while the late remote result does exactly once.
    const replayedLaunch = await t.target.attachSession(sessionId);
    if (replayedLaunch.state === undefined) throw new Error("replayed launch has no stream cursor");
    const replayedCompletion = await t.target
      .watchTurn(sessionId, { startIndex: replayedLaunch.state.streamIndex })
      .result();
    const replayedEvents = [...replayedLaunch.events, ...replayedCompletion.events];
    await t.require(
      replayedEvents,
      satisfies(
        (events: typeof replayedEvents) =>
          !JSON.stringify(events).includes(PREMATURE) &&
          events.filter(
            (event) =>
              event.type === "message.completed" &&
              event.data.message !== null &&
              JSON.stringify(event.data.message).includes(FINAL),
          ).length === 1,
        "replay retains one final remote result and no premature fallback",
      ),
    );

    // Across both turns, assert exactly one final non-null delivery crosses the channel boundary.
    const allEvents = [...launch.events, ...completed.events];
    await t.require(
      allEvents,
      satisfies(
        (events: typeof allEvents) =>
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

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message
    .flatMap((part) =>
      part !== null &&
      typeof part === "object" &&
      Reflect.get(part, "type") === "text" &&
      typeof Reflect.get(part, "text") === "string"
        ? [Reflect.get(part, "text") as string]
        : [],
    )
    .join("\n");
}
