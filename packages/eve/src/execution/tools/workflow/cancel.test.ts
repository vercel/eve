import { beforeEach, describe, expect, it, vi } from "vitest";

import { EntityConflictError, HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { cancelRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { logError } from "#internal/logging.js";
import { cancelWorkflowToolRun } from "./cancel.js";

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  cancelRun: vi.fn(),
  getWorld: vi.fn(),
  resumeHook: vi.fn(),
}));

vi.mock("#internal/logging.js", () => ({
  createLogger: vi.fn(() => ({})),
  logError: vi.fn(),
}));

const world = {} as Awaited<ReturnType<typeof getWorld>>;
const address = { hookToken: "generated-control-token", runId: "tool-run" };
const reason = "The calling turn was cancelled.";

describe("cancelWorkflowToolRun", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getWorld).mockResolvedValue(world);
  });

  it("lets a registered workflow cancel cooperatively", async () => {
    await cancelWorkflowToolRun(address, reason);

    expect(resumeHook).toHaveBeenCalledWith(address.hookToken, { kind: "cancel", reason });
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("cancels by run ID before the control hook is registered", async () => {
    vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError(address.hookToken));

    await cancelWorkflowToolRun(address, reason);

    expect(cancelRun).toHaveBeenCalledWith(world, address.runId, { cancelReason: reason });
    expect(logError).not.toHaveBeenCalled();
  });

  it("ignores a run that finishes before the cancellation fallback", async () => {
    vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError(address.hookToken));
    vi.mocked(cancelRun).mockRejectedValue(new EntityConflictError("Run already completed"));

    await expect(cancelWorkflowToolRun(address, reason)).resolves.toBeUndefined();

    expect(cancelRun).toHaveBeenCalledOnce();
    expect(logError).not.toHaveBeenCalled();
  });

  it("falls back on delivery errors and logs an unsuccessful cancellation", async () => {
    vi.mocked(resumeHook).mockRejectedValue(new Error("hook delivery unavailable"));
    vi.mocked(cancelRun).mockRejectedValue(new Error("run cancellation unavailable"));

    await expect(cancelWorkflowToolRun(address, reason)).resolves.toBeUndefined();

    expect(cancelRun).toHaveBeenCalledWith(world, address.runId, { cancelReason: reason });
    expect(logError).toHaveBeenCalledTimes(2);
  });
});
