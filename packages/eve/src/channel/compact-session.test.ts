import { describe, expect, it, vi } from "vitest";

import { createCompactFn } from "#channel/compact-session.js";
import type { Runtime } from "#channel/types.js";

describe("createCompactFn", () => {
  it("dispatches compact through the namespaced channel address", async () => {
    const runtime = {
      createSession: vi.fn(),
      dispatchContinuation: vi.fn().mockResolvedValue({ sessionId: "sess_1", status: "accepted" }),
      dispatchSession: vi.fn(),
      getEventStream: vi.fn(),
      getStreamTailIndex: vi.fn(),
      resolveContinuation: vi.fn(),
    } satisfies Runtime;

    await expect(
      createCompactFn(runtime, "slack")({ continuationToken: "C1:T1" }),
    ).resolves.toEqual({ sessionId: "sess_1", status: "accepted" });
    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: { kind: "compact" },
      continuationToken: "slack:C1:T1",
    });
  });
});
