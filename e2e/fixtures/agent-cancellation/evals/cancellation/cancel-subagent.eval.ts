import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const RECOVERY_REQUEST = "RESUME-CANCELLED-SLEEPER";
const RECOVERY_RESULT = "CANCELLED-SUBAGENT-RECOVERED";

export default defineEval({
  description:
    "Cancel a parent turn, cascade cancellation to its local sleeper subagent, then resume that child.",
  timeoutMs: 240_000,

  async test(t) {
    const session = await t.session();
    // Explicit directive phrasing keeps the delegation deterministic so a
    // scripted mock responder can drive this eval in the world suites.
    const parent = await session.start(
      "Use the workflow tool exactly once to call the sleeper subagent with message 'Call the wait-for-cancellation tool exactly once and wait until this delegated turn is cancelled.' Return the sleeper result.",
    );
    const started = await parent.waitForEvent("task.started", {
      data: { name: "sleeper" },
    });
    const taskId = started.data.taskId;
    const childSessionId = started.data.child?.sessionId;
    if (childSessionId === undefined)
      throw new Error("Cancelled sleeper task has no child session.");

    const child = t.target.watchTurn(childSessionId);
    await child.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some(
            (action) => action.kind === "tool-call" && action.toolName === "wait-for-cancellation",
          ),
      },
    });

    const cancelled = await parent.cancel();
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) => value.status === "accepted",
        "parent cancel request is accepted",
      ),
    );

    const [parentTurn, childTurn] = await Promise.all([parent.result(), child.result()]);
    childTurn.event("turn.cancelled", { count: 1 });
    childTurn.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    childTurn.notEvent("turn.failed");
    childTurn.notEvent("session.failed");

    parentTurn.event("turn.cancelled", { count: 1 });
    parentTurn.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    // The owner reports the cancelled task once; the child's confirmation adds nothing.
    parentTurn.event("task.settled", { count: 1, data: { status: "cancelled", taskId } });
    parentTurn.notEvent("task.settled", { data: { status: "completed" } });
    parentTurn.notEvent("turn.failed");
    parentTurn.notEvent("session.failed");

    const followUp = await session.send("Reply with exactly CANCELLATION-SUBAGENT-FOLLOW-UP-OK.");
    followUp.expectOk();
    followUp.notEvent("turn.cancelled");
    followUp.messageIncludes(/CANCELLATION-SUBAGENT-FOLLOW-UP-OK/i);

    // The cancelled child stays available, so it must appear among the idle
    // agents in the parent's [Tasks] note. A task left `working` never
    // appears there, which catches cancellation regressing to a leak.
    const listing = await session.send(
      "Look at the [Tasks] note in your context and reply with the sleeper agent's entry verbatim, including its status.",
    );
    listing.expectOk();
    listing.notEvent("turn.cancelled");
    listing.messageIncludes(/sleeper/i);
    listing.messageIncludes(/Cancelled\./);

    const resumed = await session.send(
      [
        "Use the workflow tool exactly once.",
        `In its JavaScript, call ctx.agent for sleeper with taskId ${JSON.stringify(taskId)} and message ${JSON.stringify(RECOVERY_REQUEST)}.`,
        "Return the inline result and reply with it verbatim. Do not call sleeper outside workflow.",
      ].join(" "),
    );
    resumed.expectOk();
    resumed.messageIncludes(RECOVERY_RESULT);
    resumed.event("task.started", {
      count: 1,
      data: { child: { sessionId: childSessionId }, name: "sleeper", taskId },
    });
    resumed.event("task.settled", { count: 1, data: { status: "completed", taskId } });

    t.event("turn.cancelled", { count: 2 });
    t.event("task.started", { count: 2, data: { name: "sleeper" } });
  },
});
