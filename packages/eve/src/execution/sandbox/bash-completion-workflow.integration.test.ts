import { describe, expect, it } from "vitest";

import { bashCompletionWorkflow } from "#execution/sandbox/bash-completion-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";

describe("bashCompletionWorkflow integration", () => {
  it("registers its stable control hook and closes before observing the command", async () => {
    const controlToken = "eve:bash-completion:session-1:process-1";
    const run = await start(bashCompletionWorkflow, [
      {
        controlToken,
        deliveryId: "eve:bash-completion-delivery:session-1:process-1",
        processId: "process-1",
        sandboxState: { initialized: true, session: null },
        serializedContext: {},
        sessionId: "session-1",
      },
    ]);

    await waitForHook(run, { token: controlToken });
    await resumeHook(controlToken, { kind: "close" });

    await expect(run.returnValue).resolves.toEqual({ status: "closed" });
  });
});
