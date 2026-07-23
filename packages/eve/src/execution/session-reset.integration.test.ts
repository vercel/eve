import { describe, expect, it } from "vitest";

import { sessionDeliveryHookWorkflow } from "#internal/testing/session-delivery-hook-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

describe("session reset integration", () => {
  it("releases a parked continuation token before reset resolves", async () => {
    const continuationToken = "http:session-reset-immediate-reuse";
    const runtime = createWorkflowRuntime({
      compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource,
    });
    const first = await start(sessionDeliveryHookWorkflow, [
      { nextToken: continuationToken, token: "http:session-reset-placeholder-1" },
    ]);

    try {
      await waitForHook(first, { token: continuationToken });

      await expect(
        runtime.terminateSession({ reason: "User requested /new", sessionId: first.runId }),
      ).resolves.toEqual({ status: "terminated" });

      await expect(runtime.resolveSession(continuationToken)).resolves.toBeUndefined();
      await expect(getWorld().then((world) => world.runs.get(first.runId))).resolves.toMatchObject({
        status: "cancelled",
      });

      const second = await start(sessionDeliveryHookWorkflow, [
        { nextToken: continuationToken, token: "http:session-reset-placeholder-2" },
      ]);
      try {
        await expect(waitForHook(second, { token: continuationToken })).resolves.toMatchObject({
          runId: second.runId,
        });
        await expect(runtime.resolveSession(continuationToken)).resolves.toEqual({
          sessionId: second.runId,
        });
      } finally {
        await second.cancel();
      }
    } finally {
      await first.cancel();
    }
  });
});
