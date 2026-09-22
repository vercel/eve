import assert from "node:assert/strict";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { releaseVerification, resetSessions, waitForVerification } from "./fixture.js";

export default defineEval({
  tags: ["real-model"],
  timeoutMs: 240_000,
  description:
    "The built-in agent yields with nested work pending and delivers the final result once.",
  async test(t) {
    const key = crypto.randomUUID();
    const sessions: string[] = [];
    try {
      // The caller delegates to agent and yields.
      const caller = await t.session();
      sessions.push(caller.sessionId);
      const callerTurn = (
        await caller.send(`Help Alice prepare her project status update.
Use the built-in agent tool to create a detector, passing the request below in its message.
After delegation, acknowledge that it is underway and finish your turn.
When the delegated task completes, forward its receipt unchanged.

Request to delegate:
Ask verification-worker to fetch Alice's verification receipt by calling verification_gate with key ${key}.
While the worker is busy, acknowledge that verification is running and finish your turn.
When the worker completes, forward its receipt unchanged.`)
      ).expectOk();
      callerTurn.requireToolCall("agent", { output: { status: "working" } });
      callerTurn.notEvent("subagent.completed");
      const callerCompletion = t.target.watchTurn(caller.sessionId, {
        startIndex: caller.state.streamIndex,
      });
      const detectorCall =
        callerTurn.events.find((event) => event.type === "subagent.called") ??
        (await callerCompletion.waitForEvent("subagent.called"));
      assert.equal(detectorCall.data.name, "agent");
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

      // Neither yielded turn may complete the caller's task while the worker is gated.
      await waitForVerification(t, workerCall.data.childSessionId, key);
      t.check(
        callerCompletion.events.filter((event) => event.type === "subagent.completed").length,
        equals(0),
      ).label("no completion before verification finishes");

      // The receipt is created on release, so no model can obtain it from the prompt.
      const receipt = await releaseVerification(t, workerCall.data.childSessionId, key);
      const workerResult = (await workerCompletion.result()).expectOk();
      workerResult.calledTool("verification_gate", {
        input: { key },
        output: receipt,
        status: "completed",
        count: 1,
      });
      workerResult.messageIncludes(receipt);
      const detectorResult = (await detectorCompletion.result()).expectOk();
      detectorResult.event("subagent.completed", {
        data: { subagentName: "verification-worker", output: receipt },
        count: 1,
      });
      detectorResult.messageIncludes(receipt);
      const callerResult = (await callerCompletion.result()).expectOk();
      callerResult.event("subagent.completed", { count: 1 });
      callerResult.event("subagent.completed", {
        data: { subagentName: "agent", output: receipt },
        count: 1,
      });
      callerResult.messageIncludes(receipt);
      t.noFailedActions();
      t.succeeded();
    } finally {
      await resetSessions(t, sessions);
    }
  },
});
