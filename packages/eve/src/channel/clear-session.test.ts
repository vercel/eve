import { describe, expect, it, vi } from "vitest";

import { createClearFn } from "#channel/clear-session.js";
import type { Runtime } from "#channel/types.js";

function createRuntime(): Runtime {
  return {
    cancelTurn: vi.fn(),
    clearSession: vi.fn().mockResolvedValue({ sessionId: "sess_1", status: "accepted" }),
    compactSession: vi.fn(),
    deliver: vi.fn(),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveSession: vi.fn(),
    run: vi.fn(),
    terminateSession: vi.fn(),
  };
}

describe("createClearFn", () => {
  it("namespaces the channel-local token and returns the runtime result", async () => {
    const runtime = createRuntime();

    await expect(createClearFn(runtime, "slack")({ continuationToken: "C1:T1" })).resolves.toEqual({
      sessionId: "sess_1",
      status: "accepted",
    });
    expect(runtime.clearSession).toHaveBeenCalledWith({
      continuationToken: "slack:C1:T1",
    });
  });
});
