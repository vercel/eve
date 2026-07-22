import { describe, expect, it, vi } from "vitest";

import { createCancelFn } from "#channel/cancel.js";
import type { Runtime } from "#channel/types.js";

function createRuntime(overrides?: Partial<Runtime>): Runtime {
  return {
    cancelTurn: vi.fn().mockResolvedValue({ status: "accepted" }),
    deliver: vi.fn(),
    getEventStream: vi.fn(),
    resolveSession: vi.fn().mockResolvedValue({ sessionId: "sess_1" }),
    run: vi.fn(),
    ...overrides,
  };
}

describe("createCancelFn", () => {
  it("namespaces the channel-local token before resolving the session", async () => {
    const runtime = createRuntime();

    const cancel = createCancelFn(runtime, "slack");
    await cancel({ continuationToken: "C1:T1" });

    expect(runtime.resolveSession).toHaveBeenCalledWith("slack:C1:T1");
  });

  it("cancels the resolved session and forwards the turn guard", async () => {
    const runtime = createRuntime();

    const cancel = createCancelFn(runtime, "slack");
    const result = await cancel({ continuationToken: "C1:T1", turnId: "turn_3" });

    expect(result).toEqual({ status: "accepted" });
    expect(runtime.cancelTurn).toHaveBeenCalledWith({ sessionId: "sess_1", turnId: "turn_3" });
  });

  it("returns 'no_active_turn' for a token no session owns", async () => {
    const runtime = createRuntime({ resolveSession: vi.fn().mockResolvedValue(undefined) });

    const cancel = createCancelFn(runtime, "slack");
    const result = await cancel({ continuationToken: "unknown" });

    expect(result).toEqual({ status: "no_active_turn" });
    expect(runtime.cancelTurn).not.toHaveBeenCalled();
  });

  it("passes through the runtime's cancellation status", async () => {
    const runtime = createRuntime({
      cancelTurn: vi.fn().mockResolvedValue({ status: "no_active_turn" }),
    });

    const cancel = createCancelFn(runtime, "slack");

    await expect(cancel({ continuationToken: "C1:T1" })).resolves.toEqual({
      status: "no_active_turn",
    });
  });

  it("propagates unexpected resolution failures and never starts a session", async () => {
    const failure = new Error("transient backing-store outage");
    const runtime = createRuntime({ resolveSession: vi.fn().mockRejectedValue(failure) });

    const cancel = createCancelFn(runtime, "slack");

    await expect(cancel({ continuationToken: "C1:T1" })).rejects.toBe(failure);
    expect(runtime.cancelTurn).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
    expect(runtime.deliver).not.toHaveBeenCalled();
  });
});
