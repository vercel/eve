import { describe, expect, it, vi } from "vitest";

// Its own file, so only this program runs under the shortened limit; slow CI
// runners spend over a second of JavaScript on ordinary programs.
vi.mock("#execution/dynamic-workflow/schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/dynamic-workflow/schema.js")>()),
  WORKFLOW_PROGRAM_CPU_TIMEOUT_MS: 1_000,
}));

import { runWorkflowProgramStep } from "#execution/dynamic-workflow/program-step.js";

describe("workflow program sandbox CPU limit", () => {
  it("stops a runaway program at the CPU limit", async () => {
    await expect(
      runWorkflowProgramStep({
        callId: "cpu",
        program: {
          continuationSecurity: { maxAgeMs: 60_000, signingKey: "workflow-program-cpu-test-key" },
          js: "while (true) {}",
          maxSubagents: 1,
        },
      }),
    ).rejects.toThrow("JavaScript runtime exceeded its CPU time limit of 1000ms.");
  });
});
