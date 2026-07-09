import { describe, expect, it } from "vitest";

import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { cancellableSessionWorkflow } from "#internal/testing/cancellable-session-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

describe("session cancellation integration", () => {
  it("releases the hook and allows a fresh run to reclaim the same token", async () => {
    const token = `http:session-cancellation:${crypto.randomUUID()}`;
    const runtime = createWorkflowRuntime({
      compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource,
    });
    const firstRun = await start(cancellableSessionWorkflow, [token]);

    try {
      await waitForHook({ runId: firstRun.runId }, { token });

      await expect(runtime.cancelSession({ continuationToken: token })).resolves.toEqual({
        sessionId: firstRun.runId,
      });
      await expect(firstRun.status).resolves.toBe("cancelled");
      await expect(runtime.cancelSession({ continuationToken: token })).rejects.toSatisfy(
        isRuntimeNoActiveSessionError,
      );
      await expect(
        resumeHook(token, { kind: "deliver", payloads: [{ message: "too late" }] }),
      ).rejects.toMatchObject({ name: "HookNotFoundError" });

      const replacementRun = await start(cancellableSessionWorkflow, [token]);
      try {
        await waitForHook({ runId: replacementRun.runId }, { token });
        expect(replacementRun.runId).not.toBe(firstRun.runId);
      } finally {
        const status = await replacementRun.status;
        if (status === "pending" || status === "running") await replacementRun.cancel();
      }
    } finally {
      const status = await firstRun.status;
      if (status === "pending" || status === "running") await firstRun.cancel();
    }
  });
});
