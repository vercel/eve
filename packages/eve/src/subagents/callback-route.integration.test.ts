// @linux-only: Workflow replay of a reply hook's token behind the callback route
import { expect, it } from "vitest";

import { agentReplyWorkflow } from "#internal/testing/workflow-api-workflows.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { start } from "#internal/workflow/runtime.js";
import { handleSessionCallbackRequest } from "#subagents/callback-route.js";

const usageDelta = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };

it("resumes a run's reply hook, which keeps its token when the run replays", async () => {
  const run = await start(agentReplyWorkflow, []);
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
  } finally {
    if (["pending", "running"].includes(await run.status)) await run.cancel();
  }
});
