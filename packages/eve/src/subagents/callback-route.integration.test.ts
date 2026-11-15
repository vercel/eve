// @linux-only: Workflow hook metadata behind the callback route
import { describe, expect, it } from "vitest";

import {
  agentReplyWorkflow,
  hookRegistrationWorkflow,
} from "#internal/testing/workflow-api-workflows.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { handleSessionCallbackRequest } from "#subagents/callback-route.js";

const usageDelta = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };

/** A remote agent's settled turn, posted to the callback route as the token's holder. */
function postSettledTurn(token: string): Promise<Response> {
  return handleSessionCallbackRequest(
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
}

async function cancelIfRunning(run: { status: Promise<string>; cancel(): Promise<void> }) {
  if (["pending", "running"].includes(await run.status)) await run.cancel();
}

describe("handleSessionCallbackRequest against Workflow hooks", () => {
  it("resumes the hook a run awaits an agent's reply on", async () => {
    const run = await start(agentReplyWorkflow, []);
    try {
      const { token } = await waitForHook(run);
      const response = await postSettledTurn(token);
      expect(response.status).toBe(202);
      await expect(run.returnValue).resolves.toMatchObject({
        kind: "runtime-action-result",
        results: [{ callId: "call-1", kind: "subagent-result", output: "paid" }],
      });
    } finally {
      await cancelIfRunning(run);
    }
  });

  it("reports a hook authored code created as not pending, and leaves it waiting", async () => {
    // Alice's order workflow waits for its payment under a token named for the order.
    const token = "order:1042";
    const run = await start(hookRegistrationWorkflow, [token, true]);
    try {
      await waitForHook(run, { token });
      const response = await postSettledTurn(token);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ code: "CALLBACK_NOT_PENDING" });

      // The hook took nothing from the callback: its first payload is the application's own.
      await resumeHook(token, "paid");
      await expect(run.returnValue).resolves.toEqual({ owner: null, payload: "paid" });
    } finally {
      await cancelIfRunning(run);
    }
  });
});
