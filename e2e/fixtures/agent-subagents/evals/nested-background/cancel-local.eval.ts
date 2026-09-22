import assert from "node:assert/strict";
import { defineEval } from "eve/evals";
import { z } from "zod";
import { resetSessions, waitForVerification, waitForVerificationCancellation } from "./fixture.js";

export default defineEval({
  tags: ["real-model"],
  timeoutMs: 240_000,
  description: "Cancelling a local subagent after it yields also cancels its nested worker.",
  async test(t) {
    const key = crypto.randomUUID();
    const sessions: string[] = [];
    try {
      // The caller delegates to local-detector and yields.
      const caller = await t.session();
      sessions.push(caller.sessionId);
      const callerTurn = (
        await caller.send(`Help Alice prepare her project status update.
Use the local-detector tool to create a detector, passing the request below in its message.
After delegation, acknowledge that it is underway and finish your turn.
When the delegated task completes, forward its receipt unchanged.

Request to delegate:
Ask verification-worker to fetch Alice's verification receipt by calling verification_gate with key ${key}.
While the worker is busy, acknowledge that verification is running and finish your turn.
When the worker completes, forward its receipt unchanged.`)
      ).expectOk();
      const delegation = callerTurn.requireToolCall("local-detector", {
        output: { status: "working" },
      });
      const { taskId } = z.object({ taskId: z.string() }).parse(delegation.output);
      callerTurn.notEvent("subagent.completed");
      const callerCompletion = t.target.watchTurn(caller.sessionId, {
        startIndex: caller.state.streamIndex,
      });
      const detectorCall =
        callerTurn.events.find((event) => event.type === "subagent.called") ??
        (await callerCompletion.waitForEvent("subagent.called"));
      assert.equal(detectorCall.data.name, "local-detector");
      sessions.push(detectorCall.data.childSessionId);

      // The detector delegates to its worker and also yields.
      const detectorTurn = (
        await t.target.watchTurn(detectorCall.data.childSessionId).result()
      ).expectOk();
      detectorTurn.requireToolCall("verification-worker", { output: { status: "working" } });
      detectorTurn.notEvent("subagent.completed");
      const detectorCompletion = t.target.watchTurn(detectorTurn.sessionId, {
        startIndex: detectorTurn.session.state.streamIndex,
      });
      const workerCall =
        detectorTurn.events.find((event) => event.type === "subagent.called") ??
        (await detectorCompletion.waitForEvent("subagent.called"));
      assert.equal(workerCall.data.name, "verification-worker");
      sessions.push(workerCall.data.childSessionId);
      const workerCompletion = t.target.watchTurn(workerCall.data.childSessionId);

      // Both delegation turns have ended, but the worker is still gated.
      await waitForVerification(t, workerCall.data.childSessionId, key);
      const cancellation = (
        await caller.send(
          `Alice no longer needs this verification. Call task_cancel with taskIds ["${taskId}"] to cancel the detector, then acknowledge the cancellation.`,
        )
      ).expectOk();
      cancellation.requireToolCall("task_cancel", {
        input: { taskIds: [taskId] },
        output: { tasks: [{ taskId, status: "cancelled" }] },
      });

      // A cancelled outer receipt is insufficient: its worker must actually stop.
      await waitForVerificationCancellation(t, workerCall.data.childSessionId, key);
      const workerResult = (await workerCompletion.result()).expectOk();
      workerResult.event("turn.cancelled", { count: 1 });
      workerResult.notEvent("turn.failed");
      workerResult.notEvent("session.failed");
      t.succeeded();
    } finally {
      await resetSessions(t, sessions);
    }
  },
});
