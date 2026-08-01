import { describe, expect, it, vi } from "vitest";

import { createCompactFn } from "#channel/compact-session.js";
import type { Runtime } from "#channel/types.js";

function createRuntime(): Runtime {
  return {
    cancelTurn: vi.fn(),
    compactSession: vi.fn().mockResolvedValue({ sessionId: "sess_1", status: "accepted" }),
    deliver: vi.fn(),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveSession: vi.fn(),
    run: vi.fn(),
    terminateSession: vi.fn(),
  };
}

describe("createCompactFn", () => {
  it("namespaces the channel-local token and returns the runtime result", async () => {
    const runtime = createRuntime();

    await expect(
      createCompactFn(runtime, "slack")({ continuationToken: "C1:T1" }),
    ).resolves.toEqual({ sessionId: "sess_1", status: "accepted" });
    expect(runtime.compactSession).toHaveBeenCalledWith({
      continuationToken: "slack:C1:T1",
    });
  });
});
