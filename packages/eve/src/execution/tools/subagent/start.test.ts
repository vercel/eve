import { beforeEach, describe, expect, it, vi } from "vitest";

import { startSubagent } from "#execution/tools/subagent/start.js";
import { startLocalSubagent } from "#subagents/start-local.js";
import { startRemoteSubagent } from "#subagents/start-remote.js";

vi.mock("#subagents/start-local.js", () => ({ startLocalSubagent: vi.fn() }));
vi.mock("#subagents/start-remote.js", () => ({ startRemoteSubagent: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(startRemoteSubagent).mockResolvedValue({ kind: "error" } as never);
});

describe("startSubagent", () => {
  it("forwards the prepared caller context and child seed unchanged", async () => {
    const parentTraceContext = {
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    };
    const traceSeed = {
      spanId: "4".repeat(16),
      traceFlags: 0,
      traceId: "3".repeat(32),
    };

    await startSubagent({
      auth: null,
      batchEvent: { sequence: 1, turnId: "turn-1" },
      bundle: {} as never,
      callbackBaseUrl: "https://parent.example",
      capabilities: undefined,
      channelMetadata: undefined,
      currentSession: {} as never,
      fanoutSize: 1,
      initiatorAuth: null,
      parentContinuationToken: "parent-token",
      sandboxSessionId: "parent-session",
      session: { sessionId: "parent-session" } as never,
      target: {
        action: { callId: "child-action" } as never,
        kind: "remote",
      },
      traceDispatch: {
        originAudience: "private",
        parentTraceContext,
        traceSeed,
      },
    });

    expect(startRemoteSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        traceDispatch: {
          originAudience: "private",
          parentTraceContext,
          traceSeed,
        },
      }),
    );
    expect(startLocalSubagent).not.toHaveBeenCalled();
  });
});
