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

  it("treats an unsafe entity id error from the local world as not found", async () => {
    const error = new Error('Invalid runId "../escape"');
    error.name = "UnsafeEntityIdError";
    mocks.get.mockRejectedValueOnce(error);

    await expect(readOwnedInvocationRun("../escape", null)).resolves.toBeUndefined();
  });

  it("rethrows non-400 world errors", async () => {
    const error = new WorkflowWorldError(
      "GET /v2/runs/wrun_123 -> HTTP 500: Internal Server Error",
      {
        status: 500,
      },
    );
    mocks.get.mockRejectedValueOnce(error);

    await expect(readOwnedInvocationRun("wrun_123", null)).rejects.toBe(error);
  });
});
