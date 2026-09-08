import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildSubagentRunInput, createSession, waitForCommandHookOwner } = vi.hoisted(() => ({
  buildSubagentRunInput: vi.fn(() => ({
    childContinuationToken: "child-token",
    runInput: { input: { message: "work" } },
  })),
  createSession: vi.fn(async () => ({ sessionId: "child-session" })),
  waitForCommandHookOwner: vi.fn(async () => ({ runId: "child-session" })),
}));

vi.mock("#subagents/tool.js", () => ({ buildSubagentRunInput }));
vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: () => ({ createSession }),
  waitForCommandHookOwner,
}));

import { startLocalSubagent } from "#subagents/start-local.js";

describe("startLocalSubagent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes an inherited task activity observer through unchanged", async () => {
    const activityObserver = {
      sink: { url: "https://parent.example/activity", version: 1 as const },
      workIdentity: {
        id: "work:task",
        kind: "task" as const,
        name: "slack",
        parentId: "work:root",
        rootSessionId: "root-session",
        rootTurnId: "root-turn",
      },
    };

    await startLocalSubagent({
      action: {
        callId: "call-1",
        input: { message: "Search Slack" },
        kind: "subagent-call",
        name: "slack",
        nodeId: "subagents/slack",
        subagentName: "slack",
      },
      activityObserver,
      auth: null,
      batchEvent: { sequence: 0, turnId: "parent-turn" },
      bundle: { compiledArtifactsSource: {}, graph: {} },
      capabilities: undefined,
      channelMetadata: undefined,
      currentSession: { sessionId: "parent-session" },
      fanoutSize: 1,
      initiatorAuth: null,
      parentContinuationToken: "parent-token",
      parentTraceContext: undefined,
      sandboxSessionId: "sandbox-session",
      session: { sessionId: "parent-session" },
      source: { description: "Search Slack", type: "local" },
    } as never);

    expect(buildSubagentRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ activityObserver }),
    );
    expect(createSession).toHaveBeenCalledOnce();
  });
});
