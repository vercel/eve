import assert from "node:assert/strict";

import { defineEval } from "eve/evals";

import { withOldDeployment } from "./redeploy";
import { postChannel } from "./shared";

export default defineEval({
  description: "A new worker completes and wakes its parent session created on eve@0.50.0.",
  tags: ["redeploy"],
  timeoutMs: 20 * 60_000,
  async test(t) {
    await withOldDeployment(t, "0.50.0", async (upgrade) => {
      const sessionRef = crypto.randomUUID();
      const started = await postChannel<{ sessionId: string }>(t.target, "/cross-version-webhook", {
        message: "Create the session before upgrading.",
        sessionRef,
      });
      const parent = t.target.watchTurn(started.sessionId);
      (await parent.result()).expectOk();

      await upgrade();

      const resumed = await postChannel<{ sessionId: string }>(t.target, "/cross-version-webhook", {
        message: "CROSS-VERSION-START-WORKER",
        sessionRef,
      });
      assert.equal(resumed.sessionId, started.sessionId, "the parent must remain the old session");
      assert.notEqual(parent.session.state?.streamIndex, undefined);
      const delegation = t.target.watchTurn(started.sessionId, {
        startIndex: parent.session.state!.streamIndex,
      });
      const receipt = await delegation.result();
      receipt.expectOk();
      receipt.calledTool("agent", { count: 1, output: { status: "working" } });
      receipt.messageIncludes("CROSS-VERSION-WORKER-STARTED");

      // Observe the callback; sending another message would hide a missing parent wake.
      assert.notEqual(delegation.session.state?.streamIndex, undefined);
      const completed = await t.target
        .watchTurn(started.sessionId, {
          startIndex: delegation.session.state!.streamIndex,
        })
        .result();
      completed.expectOk();
      completed.messageIncludes("CROSS-VERSION-WORKER-RESULT");
    });
  },
});
