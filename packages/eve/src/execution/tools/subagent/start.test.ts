import { beforeEach, describe, expect, it, vi } from "vitest";

import { startSubagent } from "#execution/tools/subagent/start.js";
import { startLocalSubagent } from "#subagents/start-local.js";
import { startRemoteSubagent } from "#subagents/start-remote.js";
import { allocateChildSessionTraceSeed } from "#tracing/agent-child-trace-seed.js";
import { readActionTraceContext } from "#tracing/agent-trace-context-store.js";

vi.mock("#subagents/start-local.js", () => ({ startLocalSubagent: vi.fn() }));
vi.mock("#subagents/start-remote.js", () => ({ startRemoteSubagent: vi.fn() }));
vi.mock("#tracing/agent-child-trace-seed.js", () => ({
  allocateChildSessionTraceSeed: vi.fn(),
}));
vi.mock("#tracing/agent-trace-context-store.js", () => ({
  readActionTraceContext: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(allocateChildSessionTraceSeed).mockReturnValue({
    spanId: "6".repeat(16),
    traceFlags: 0,
    traceId: "5".repeat(32),
  });
  vi.mocked(startRemoteSubagent).mockResolvedValue({ kind: "error" } as never);
});

describe("startSubagent", () => {
  it("links the child to the exact instrumented caller span", async () => {
    const caller = {
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    };
    const childAction = {
      spanId: "4".repeat(16),
      traceFlags: 1,
      traceId: "3".repeat(32),
    };
    vi.mocked(readActionTraceContext).mockImplementation(
      (_serializedContext, _sessionId, _turnId, callId) =>
        callId === "workflow-call" ? caller : childAction,
    );

    await startSubagent({
      auth: null,
      batchEvent: { sequence: 1, turnId: "turn-1" },
      bundle: {} as never,
      callbackBaseUrl: "https://parent.example",
      capabilities: undefined,
      channelMetadata: undefined,
      currentSession: {} as never,
      fanoutSize: 1,
      instrumentationCallId: "workflow-call",
      initiatorAuth: null,
      parentContinuationToken: "parent-token",
      parentTraceContext: undefined,
      sandboxSessionId: "parent-session",
      serializedContext: {},
      session: { sessionId: "parent-session" } as never,
      target: {
        action: { callId: "child-action" } as never,
        kind: "remote",
      },
    });

    expect(readActionTraceContext).toHaveBeenCalledWith(
      {},
      "parent-session",
      "turn-1",
      "workflow-call",
    );
    expect(startRemoteSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ parentTraceContext: caller }),
    );
    expect(startLocalSubagent).not.toHaveBeenCalled();
  });
});
