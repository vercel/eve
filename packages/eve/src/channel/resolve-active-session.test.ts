import { describe, expect, it, vi } from "vitest";

import { createResolveActiveSessionFn } from "#channel/resolve-active-session.js";
import type { Runtime } from "#channel/types.js";

function runtime(): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn(),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream()),
    getStreamTailIndex: vi.fn().mockResolvedValue(-1),
    resolveContinuation: vi.fn(),
  };
}

describe("createResolveActiveSessionFn", () => {
  it("resolves a channel-local continuation using the authored channel name", async () => {
    const mockRuntime = runtime();
    vi.mocked(mockRuntime.resolveContinuation).mockResolvedValue({ sessionId: "session-1" });

    await expect(
      createResolveActiveSessionFn(mockRuntime, "support")({ continuationToken: "C1:T1" }),
    ).resolves.toEqual({ sessionId: "session-1" });
    expect(mockRuntime.resolveContinuation).toHaveBeenCalledWith("support:C1:T1");
  });

  it("returns undefined for an inactive continuation", async () => {
    const mockRuntime = runtime();
    vi.mocked(mockRuntime.resolveContinuation).mockResolvedValue(undefined);

    await expect(
      createResolveActiveSessionFn(mockRuntime, "support")({ continuationToken: "C1:T1" }),
    ).resolves.toBeUndefined();
  });
});
