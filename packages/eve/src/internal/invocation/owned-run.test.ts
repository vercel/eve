import { describe, expect, it, vi } from "vitest";
import { WorkflowWorldError } from "#compiled/@workflow/errors/index.js";
import { readOwnedInvocationRun } from "./owned-run.js";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: async () => ({ runs: { get: mocks.get } }),
}));

describe("readOwnedInvocationRun", () => {
  it("treats an invocation id the world rejects as malformed as not found", async () => {
    mocks.get.mockRejectedValueOnce(
      new WorkflowWorldError("GET /v2/runs/timing-test-0000 -> HTTP 400: Bad Request", {
        status: 400,
        code: "validation-error",
      }),
    );

    await expect(readOwnedInvocationRun("timing-test-0000", null)).resolves.toBeUndefined();
  });
});
