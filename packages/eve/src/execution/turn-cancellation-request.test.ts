import { afterEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import {
  isRetryableInactiveCancelReason,
  requestWorkflowTurnCancellation,
} from "#execution/turn-cancellation-request.js";
import { getWorld, reenqueueRun, resumeHook } from "#internal/workflow/runtime.js";

vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: vi.fn(),
  reenqueueRun: vi.fn(),
  resumeHook: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("requestWorkflowTurnCancellation", () => {
  it("resumes the session cancel hook and nudges the hook's owning run", async () => {
    // The cancel hook is created by the turn workflow run, not the session's
    // driver run, so the scheduler nudge must target the hook's runId.
    const world = { kind: "test-world" };
    vi.mocked(resumeHook).mockResolvedValue({ runId: "turn-run-1" } as never);
    vi.mocked(getWorld).mockResolvedValue(world as never);
    vi.mocked(reenqueueRun).mockResolvedValue(undefined as never);

    const result = await requestWorkflowTurnCancellation({ sessionId: "session-1" });

    expect(result).toEqual({ status: "accepted" });
    expect(resumeHook).toHaveBeenCalledWith("session-1:cancel", {});
    expect(reenqueueRun).toHaveBeenCalledWith(world, "turn-run-1");
  });

  it("falls back to the session id when the hook carries no run id", async () => {
    const world = { kind: "test-world" };
    vi.mocked(resumeHook).mockResolvedValue({} as never);
    vi.mocked(getWorld).mockResolvedValue(world as never);
    vi.mocked(reenqueueRun).mockResolvedValue(undefined as never);

    const result = await requestWorkflowTurnCancellation({ sessionId: "session-1" });

    expect(result).toEqual({ status: "accepted" });
    expect(reenqueueRun).toHaveBeenCalledWith(world, "session-1");
  });

  it("stays accepted when the scheduler nudge fails", async () => {
    // The resume payload is durable; a failed re-enqueue only re-exposes the
    // world's wake race and must not fail the cancel request.
    vi.mocked(resumeHook).mockResolvedValue({ runId: "session-1" } as never);
    vi.mocked(getWorld).mockRejectedValue(new Error("world unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestWorkflowTurnCancellation({ sessionId: "session-1" });

    expect(result).toEqual({ status: "accepted" });
    expect(error).toHaveBeenCalled();
  });

  it("classifies a missing hook as no_active_turn without nudging", async () => {
    vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError("no hook"));

    const result = await requestWorkflowTurnCancellation({ sessionId: "session-1" });

    expect(result).toEqual({ reason: "HookNotFoundError", status: "no_active_turn" });
    expect(reenqueueRun).not.toHaveBeenCalled();
  });

  it("forwards the turn guard in the hook payload", async () => {
    vi.mocked(resumeHook).mockResolvedValue({ runId: "session-1" } as never);
    vi.mocked(getWorld).mockResolvedValue({} as never);

    await requestWorkflowTurnCancellation({ sessionId: "session-1", turnId: "turn_3" });

    expect(resumeHook).toHaveBeenCalledWith("session-1:cancel", { turnId: "turn_3" });
  });
});

describe("isRetryableInactiveCancelReason", () => {
  it("retries only hook-claim contention", () => {
    expect(isRetryableInactiveCancelReason("EntityConflictError")).toBe(true);
    expect(isRetryableInactiveCancelReason("HookNotFoundError")).toBe(false);
    expect(isRetryableInactiveCancelReason("WorkflowRunNotFoundError")).toBe(false);
    expect(isRetryableInactiveCancelReason(undefined)).toBe(false);
  });
});
