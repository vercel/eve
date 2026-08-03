import { describe, expect, it, vi } from "vitest";

import { createCancelFn } from "#channel/cancel.js";
import type { Runtime } from "#channel/types.js";

function createRuntime(): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn().mockResolvedValue({ status: "accepted" }),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveContinuation: vi.fn(),
  };
}

describe("createCancelFn", () => {
  it("dispatches directly through the namespaced channel address", async () => {
    const runtime = createRuntime();

    await expect(
      createCancelFn(runtime, "slack")({ continuationToken: "C1:T1", turnId: "turn_3" }),
    ).resolves.toEqual({ status: "accepted" });
    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: { kind: "cancel", turnId: "turn_3" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.resolveContinuation).not.toHaveBeenCalled();
  });

  it("passes through no_active_turn", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation).mockResolvedValue({ status: "no_active_turn" });

    await expect(
      createCancelFn(runtime, "slack")({ continuationToken: "unknown" }),
    ).resolves.toEqual({ status: "no_active_turn" });
  });

  it("propagates dispatch failures without creating a session", async () => {
    const failure = new Error("transient backing-store outage");
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation).mockRejectedValue(failure);

    await expect(createCancelFn(runtime, "slack")({ continuationToken: "C1:T1" })).rejects.toBe(
      failure,
    );
    expect(runtime.createSession).not.toHaveBeenCalled();
  });
});
