import { requireBackgroundTaskId, waitForTaskInput, waitForTaskNotification } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

/** Plain session cancellation remains turn-only while the parent is parked. */
export default defineTaskEval({
  description: "session.cancel() preserves an admitted background task by default.",
  transition: {
    primary: "task.lifecycle.cancel.default-preserves-nonterminal",
    setup: ["task.dispatch.start.accepted-acknowledged", "task.input.require.accepted-valid-batch"],
    dimensions: { transport: "local", parentPhase: "parked" },
  },
  async test(t) {
    const started = await t.send("TASK-CANCEL-SETUP");
    started.expectOk();
    const taskId = requireBackgroundTaskId(started);
    const blocked = await waitForTaskInput(t, t, "release");
    const sessionId = blocked.session.sessionId;
    if (sessionId === undefined) throw new Error("Task parent has no session id.");

    const response = await t.target.fetch(`/eve/v1/session/${sessionId}/cancel`, {
      method: "POST",
    });
    if (response.status !== 202) {
      throw new Error(`Plain parked cancellation returned HTTP ${response.status}.`);
    }

    const answered = await blocked.session.respond([
      { optionId: "approve", requestId: blocked.request.requestId },
    ]);
    answered.expectOk();

    const completed = await waitForTaskNotification(t, blocked.session, taskId, "completed", [
      answered,
    ]);
    const followUp = await completed.session.send("TASK-CANCEL-VERIFY-NOOP");
    followUp.expectOk();
  },
});
