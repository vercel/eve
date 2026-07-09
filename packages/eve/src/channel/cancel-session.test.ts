import { describe, expect, it, vi } from "vitest";

import { createCancelSessionFn } from "#channel/cancel-session.js";
import type { Runtime } from "#channel/types.js";

describe("createCancelSessionFn", () => {
  it("qualifies identical raw tokens independently for each channel", async () => {
    const cancelSession = vi.fn().mockImplementation(async ({ continuationToken }) => ({
      sessionId: continuationToken,
    }));
    const runtime = {
      cancelSession,
      deliver: vi.fn(),
      getEventStream: vi.fn(),
      run: vi.fn(),
    } satisfies Runtime;
    const cancelSlackSession = createCancelSessionFn(runtime, "slack");
    const cancelTeamsSession = createCancelSessionFn(runtime, "teams");

    await expect(
      cancelSlackSession({ continuationToken: "conversation-1", reason: "reset" }),
    ).resolves.toEqual({ sessionId: "slack:conversation-1" });
    await expect(
      cancelTeamsSession({ continuationToken: "conversation-1", reason: "reset" }),
    ).resolves.toEqual({ sessionId: "teams:conversation-1" });

    expect(cancelSession.mock.calls).toEqual([
      [{ continuationToken: "slack:conversation-1", reason: "reset" }],
      [{ continuationToken: "teams:conversation-1", reason: "reset" }],
    ]);
  });
});
