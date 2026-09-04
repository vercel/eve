import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import { startLocalSubagent } from "#subagents/start-local.js";
import { buildSubagentRunInput } from "#subagents/tool.js";

const createSessionMock = vi.fn();

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: vi.fn(() => ({ createSession: createSessionMock })),
  waitForCommandHookOwner: vi.fn(),
}));
vi.mock("#subagents/tool.js", () => ({
  buildSubagentRunInput: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildSubagentRunInput).mockReturnValue({
    childContinuationToken: "child-token",
    runInput: {} as never,
  });
});

describe("startLocalSubagent", () => {
  it("drops a losing candidate's trace acknowledgement", async () => {
    const trace = {
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    };
    createSessionMock.mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "candidate-session",
      trace,
    });
    vi.mocked(waitForCommandHookOwner).mockResolvedValue({ runId: "winning-session" });

    const outcome = await startLocalSubagent({
      action: {
        callId: "call-1",
        name: "research",
        nodeId: "subagents/research",
        subagentName: "research",
      } as never,
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-1" },
      bundle: { compiledArtifactsSource: {} } as never,
      capabilities: undefined,
      channelMetadata: undefined,
      currentSession: {} as never,
      fanoutSize: 1,
      initiatorAuth: null,
      parentContinuationToken: "parent-token",
      parentTraceContext: undefined,
      sandboxSessionId: "parent-session",
      session: {} as never,
      source: { description: "Research", type: "local" },
      traceSeed: trace,
    });

    expect(createWorkflowRuntime).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      address: {
        continuationToken: "child-token",
        sessionId: "winning-session",
      },
      kind: "called",
    });
    expect(outcome.kind === "called" ? outcome.address.traceId : undefined).toBeUndefined();
  });
});
