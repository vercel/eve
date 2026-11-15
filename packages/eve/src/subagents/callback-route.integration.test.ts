// @linux-only: a remote reply hook on Workflow, behind the callback route
import { expect, it } from "vitest";

import { remoteReplyWorkflow } from "#internal/testing/remote-reply-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { handleSessionCallbackRequest } from "#subagents/callback-route.js";

const usageDelta = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };

it("resumes a run's remote reply hook, whose token a step drew and a replay keeps", async () => {
  const run = await start(remoteReplyWorkflow, []);
  try {
    const { token } = await waitForHook(run);
    const response = await handleSessionCallbackRequest(
      new Request(`https://eve.test/eve/v1/callback/${encodeURIComponent(token)}`, {
        body: JSON.stringify({
          callId: "call-1",
          kind: "turn.completed",
          outcome: { kind: "parked", result: { kind: "succeeded", output: "paid" }, usageDelta },
          output: "paid",
          subagentName: "billing",
        }),
        method: "POST",
      }),
      { params: { token }, requestIp: null, waitUntil() {} },
    );
    expect(response.status).toBe(202);
    // The payload wakes the run, which replays its body: the hook it opens again is the same one.
    await expect(run.returnValue).resolves.toMatchObject({
      payload: {
        kind: "runtime-action-result",
        results: [{ callId: "call-1", kind: "subagent-result", output: "paid" }],
      },
      token,
    });
    // Opening the hook is all the run did, so its one step is the one that drew the token: a
    // body's own `crypto` is seeded, and a token drawn there records no step.
    const steps = await (await getWorld()).steps.list({ resolveData: "none", runId: run.runId });
    expect(steps.data).toHaveLength(1);
  } finally {
    if (["pending", "running"].includes(await run.status)) await run.cancel();
  }
});
