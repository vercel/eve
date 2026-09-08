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
  createSessionMock.mockResolvedValue({
    events: new ReadableStream(),
    sessionId: "candidate-session",
  });
  vi.mocked(buildSubagentRunInput).mockReturnValue({
    childContinuationToken: "child-token",
    runInput: {} as never,
  });
  vi.mocked(waitForCommandHookOwner).mockResolvedValue({ runId: "winning-session" });
});

describe("startLocalSubagent", () => {
  it("uses the session that wins continuation ownership", async () => {
    const outcome = await startLocalSubagent({
      action: {
        callId: "call-1",
        name: "research",
        nodeId: "subagents/research",
        subagentName: "research",
      } as never,
      auth: null,
      bundle: { compiledArtifactsSource: {} } as never,
      capabilities: undefined,
      channelMetadata: undefined,
      currentSession: {} as never,
      fanoutSize: 1,
      initiatorAuth: null,
      parent: {
        continuationToken: "parent-token",
        lineage: {
          callId: "call-1",
          rootSessionId: "parent-session",
          sessionId: "parent-session",
          turn: { id: "turn-1", sequence: 0 },
        },
      },
      sandboxSessionId: "parent-session",
      session: {} as never,
      source: { description: "Research", type: "local" },
    });

    expect(createWorkflowRuntime).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      address: {
        continuationToken: "child-token",
        sessionId: "winning-session",
      },
      kind: "called",
    });
  });

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
        name: "slack",
        nodeId: "subagents/slack",
        subagentName: "slack",
      } as never,
      activityObserver,
      auth: null,
      bundle: { compiledArtifactsSource: {} } as never,
      capabilities: undefined,
      channelMetadata: undefined,
      currentSession: {} as never,
      fanoutSize: 1,
      initiatorAuth: null,
      parent: {
        continuationToken: "parent-token",
        lineage: {
          callId: "call-1",
          rootSessionId: "parent-session",
          sessionId: "parent-session",
          turn: { id: "turn-1", sequence: 0 },
        },
      },
      sandboxSessionId: "parent-session",
      session: {} as never,
      source: { description: "Search Slack", type: "local" },
    });

    expect(buildSubagentRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ activityObserver }),
    );
    expect(createSessionMock).toHaveBeenCalledOnce();
  });
});
