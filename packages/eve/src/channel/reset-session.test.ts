import { describe, expect, it, vi } from "vitest";

import { createResetFn } from "#channel/reset-session.js";
import type { Runtime } from "#channel/types.js";

function createRuntime(overrides?: Partial<Runtime>): Runtime {
  return {
    cancelTurn: vi.fn(),
    deliver: vi.fn(),
    getEventStream: vi.fn(),
    resolveSession: vi.fn().mockResolvedValue({ sessionId: "sess_1" }),
    run: vi.fn(),
    terminateSession: vi.fn().mockResolvedValue({ status: "terminated" }),
    ...overrides,
  };
}

describe("createResetFn", () => {
  it("namespaces the channel-local token before resolving its owner", async () => {
    const runtime = createRuntime();

    await createResetFn(runtime, "imessage")({ continuationToken: "direct:+1:+2" });

    expect(runtime.resolveSession).toHaveBeenCalledWith("imessage:direct:+1:+2");
  });

  it("returns no_active_session without terminating when no session owns the token", async () => {
    const runtime = createRuntime({ resolveSession: vi.fn().mockResolvedValue(undefined) });

    await expect(
      createResetFn(runtime, "imessage")({ continuationToken: "direct:+1:+2" }),
    ).resolves.toEqual({ status: "no_active_session" });
    expect(runtime.terminateSession).not.toHaveBeenCalled();
  });

  it("terminates the observed session id once and returns it", async () => {
    const runtime = createRuntime();

    await expect(
      createResetFn(
        runtime,
        "imessage",
      )({
        continuationToken: "direct:+1:+2",
        reason: "User requested /new",
      }),
    ).resolves.toEqual({ status: "reset", previousSessionId: "sess_1" });
    expect(runtime.terminateSession).toHaveBeenCalledWith({
      reason: "User requested /new",
      sessionId: "sess_1",
    });
    expect(runtime.resolveSession).toHaveBeenCalledOnce();
  });

  it("treats an already-terminal observed owner as a successful reset", async () => {
    const runtime = createRuntime({
      terminateSession: vi.fn().mockResolvedValue({ status: "already_terminal" }),
    });

    await expect(
      createResetFn(runtime, "imessage")({ continuationToken: "direct:+1:+2" }),
    ).resolves.toEqual({ status: "reset", previousSessionId: "sess_1" });
  });

  it("propagates unexpected resolution and termination failures", async () => {
    const resolutionFailure = new Error("World unavailable");
    const resolutionRuntime = createRuntime({
      resolveSession: vi.fn().mockRejectedValue(resolutionFailure),
    });
    await expect(
      createResetFn(resolutionRuntime, "imessage")({ continuationToken: "direct:+1:+2" }),
    ).rejects.toBe(resolutionFailure);

    const terminationFailure = new Error("World unavailable");
    const terminationRuntime = createRuntime({
      terminateSession: vi.fn().mockRejectedValue(terminationFailure),
    });
    await expect(
      createResetFn(terminationRuntime, "imessage")({ continuationToken: "direct:+1:+2" }),
    ).rejects.toBe(terminationFailure);
  });
});
