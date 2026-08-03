import { describe, expect, it, vi } from "vitest";

import { createResetFn } from "#channel/reset-session.js";
import type { Runtime } from "#channel/types.js";

function createRuntime(): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi
      .fn()
      .mockResolvedValue({ previousSessionId: "sess_1", status: "reset" }),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn().mockResolvedValue(-1),
    resolveContinuation: vi.fn(),
  };
}

describe("createResetFn", () => {
  it("dispatches reset directly through the namespaced channel address", async () => {
    const runtime = createRuntime();

    await expect(
      createResetFn(
        runtime,
        "imessage",
      )({
        continuationToken: "direct:+1:+2",
        reason: "User requested /new",
      }),
    ).resolves.toEqual({ previousSessionId: "sess_1", status: "reset" });
    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: { kind: "reset", reason: "User requested /new" },
      continuationToken: "imessage:direct:+1:+2",
    });
    expect(runtime.resolveContinuation).not.toHaveBeenCalled();
  });

  it("passes through no_active_session", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation).mockResolvedValue({ status: "no_active_session" });

    await expect(
      createResetFn(runtime, "imessage")({ continuationToken: "direct:+1:+2" }),
    ).resolves.toEqual({ status: "no_active_session" });
  });

  it("propagates dispatch failures", async () => {
    const failure = new Error("World unavailable");
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation).mockRejectedValue(failure);

    await expect(
      createResetFn(runtime, "imessage")({ continuationToken: "direct:+1:+2" }),
    ).rejects.toBe(failure);
  });
});
