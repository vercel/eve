import { describe, expect, it, vi } from "vitest";

import { createClearFn } from "#channel/clear-session.js";
import type { Runtime } from "#channel/types.js";

describe("createClearFn", () => {
  it("dispatches clear through the namespaced channel address", async () => {
    const runtime = {
      createSession: vi.fn(),
      dispatchContinuation: vi.fn().mockResolvedValue({ sessionId: "sess_1", status: "accepted" }),
      dispatchSession: vi.fn(),
      getEventStream: vi.fn(),
      getStreamTailIndex: vi.fn(),
      resolveContinuation: vi.fn(),
    } satisfies Runtime;

    await expect(createClearFn(runtime, "slack")({ continuationToken: "C1:T1" })).resolves.toEqual({
      sessionId: "sess_1",
      status: "accepted",
    });
    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: { kind: "clear" },
      continuationToken: "slack:C1:T1",
    });
  });
});
