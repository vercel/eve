import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const ALICE_REWORK =
  "WORKFLOW-SIGNOFF-CANCEL Alice wants to rework the plan before anyone signs off.";

/**
 * `sign_off_plan` is a `serve` tool whose stretch asks a person to sign off.
 * The turn holds on the task until its question parks it. Alice then changes
 * the plan: the model cancels the task, which asks the session to withdraw
 * the question, and sends the same task a note. The session withdraws the
 * question, reports it `cancelled`, and tells the run, so the body returns to
 * `receive()` and answers the note on its own run.
 */
export default defineEval({
  description: "Cancelling a resumable task withdraws its question and keeps the task serving.",
  timeoutMs: 90_000,
  async test(t) {
    const parked = await t.send("WORKFLOW-SIGNOFF-HOLD");
    t.check(parked.status, equals("waiting")).label("send() stops at the pending question");
    const request = parked.session.requireInputRequest({ toolName: "sign_off_plan" });
    const afterQuestion = parked.session.state.streamIndex;

    const reworked = await parked.session.send(ALICE_REWORK, { turnPolicy: "steer" });
    reworked.expectOk();
    reworked.calledTool("task_cancel", { count: 1, output: { status: "cancelled" } });
    reworked.messageIncludes('WORKFLOW-SIGNOFF-RESULT {"notes":["rework the plan first"]}');

    // Follow the stream as a channel does: the question resolves once, as withdrawn.
    const followed = await t.target
      .watchTurn(parked.sessionId, { startIndex: afterQuestion })
      .result();
    followed.event("input.resolved", {
      count: 1,
      data: { resolutions: [{ outcome: "cancelled", requestId: request.requestId }] },
    });
    followed.event("task.settled", { count: 1, data: { callId: "signoff", status: "cancelled" } });
    followed.event("task.settled", {
      count: 1,
      data: {
        callId: "signoff-note",
        output: { notes: ["rework the plan first"] },
        status: "completed",
      },
    });
    followed.eventOrder([
      { type: "input.resolved" },
      { data: { callId: "signoff-note" }, type: "task.settled" },
    ]);

    // The watched stream repeats the session's events, so count distinct calls.
    t.eventsSatisfy("every call reaches the one task the sign-off started", (events) => {
      const starts = events.flatMap((event) => (event.type === "task.started" ? [event.data] : []));
      const callIds = new Set(starts.map((start) => start.callId));
      const taskIds = new Set(starts.map((start) => start.taskId));
      return (
        callIds.size === 2 &&
        callIds.has("signoff") &&
        callIds.has("signoff-note") &&
        taskIds.size === 1
      );
    });
    t.noFailedActions();
  },
});
