import assert from "node:assert/strict";
import { defineEval } from "eve/evals";
import { z } from "zod";
import {
  cancellationRequest,
  resetSessions,
  signOffRequest,
  waitForVerification,
  waitForVerificationStop,
} from "./fixture.js";

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
        await caller.send(
          signOffRequest(
            "Hand this off with the local-detector tool, using the note below as its message.",
            key,
          ),
        )
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
      const cancellation = (await caller.send(cancellationRequest(taskId))).expectOk();
      cancellation.requireToolCall("task_cancel", {
        input: { taskIds: [taskId] },
        output: { tasks: [{ taskId, status: "cancelled" }] },
      });

      // A cancelled outer receipt is insufficient: its worker must actually stop.
      await waitForVerificationStop(t, workerCall.data.childSessionId, key);
      const workerResult = (await workerCompletion.result()).expectOk();
      workerResult.event("turn.cancelled", { count: 1 });
      workerResult.notEvent("turn.failed");
      workerResult.notEvent("session.failed");
      assert.equal(
        detectorCompletion.events.filter((event) => event.type === "turn.started").length,
        0,
        "cancelling nested work must not wake the cancelled detector",
      );
      t.succeeded();
    } finally {
      await resetSessions(t, sessions);
    }
  },
});
