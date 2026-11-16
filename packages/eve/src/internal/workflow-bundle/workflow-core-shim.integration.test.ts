// @linux-only: Workflow body API semantics in the VM
import { describe, expect, it } from "vitest";

import {
  catchWorkflowError,
  hookRegistrationWorkflow,
  retryAfterWorkflow,
} from "#internal/testing/workflow-api-workflows.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";

describe("workflow body APIs", () => {
  it("returns the existing hook owner and keeps the owner's hook usable", async () => {
    const token = "workflow-api:shared-token";
    const owner = await start(hookRegistrationWorkflow, [token, true]);
    try {
      await waitForHook(owner, { token });
      const contender = await start(hookRegistrationWorkflow, [token]);
      await expect(contender.returnValue).resolves.toEqual({
        owner: owner.runId,
        repeatedOwner: owner.runId,
        payloadError: "HookConflictError",
      });

      await resumeHook(token, "approved");
      await expect(owner.returnValue).resolves.toEqual({ owner: null, payload: "approved" });

      const nextOwner = await start(hookRegistrationWorkflow, [token]);
      await expect(nextOwner.returnValue).resolves.toEqual({ owner: null });
    } finally {
      if (["pending", "running"].includes(await owner.status)) await owner.cancel();
    }
  });

  it.each(["fatal", "retryable"] as const)(
    "recognizes a %s error caught from a step inside the workflow",
    async (kind) => {
      const run = await start(catchWorkflowError, [kind]);
      await expect(run.returnValue).resolves.toEqual({
        fatal: kind === "fatal",
        retryable: kind === "retryable",
        retryAfter: kind === "retryable" ? "2026-01-01T00:00:00.000Z" : null,
      });
    },
  );

  it("preserves retry dates and delays when constructing errors in a workflow", async () => {
    const run = await start(retryAfterWorkflow, []);
    await expect(run.returnValue).resolves.toEqual([1_000, 5_000, 2_500, 10_000]);
  });
});
