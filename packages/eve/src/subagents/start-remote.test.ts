import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveRemoteAgentForAction, startRemoteAgentSession } = vi.hoisted(() => ({
  resolveRemoteAgentForAction: vi.fn(() => ({ url: "https://remote.example/eve/v1" })),
  startRemoteAgentSession: vi.fn(async () => ({ sessionId: "remote-session" })),
}));

vi.mock("#subagents/remote-dispatch.js", () => ({
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
}));

import { startRemoteSubagent } from "#subagents/start-remote.js";

const taskObserver = {
  sink: { url: "https://parent.example/activity", version: 1 as const },
  workIdentity: {
    id: "work:task",
    kind: "task" as const,
    name: "research-task",
    parentId: "work:root",
    rootSessionId: "root-session",
    rootTurnId: "root-turn",
  },
};

describe("startRemoteSubagent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("nests a remote agent beneath an inherited task observer", async () => {
    await startRemoteSubagent({
      action: {
        callId: "call-remote",
        description: "Research remotely",
        input: { message: "Find it" },
        kind: "remote-agent-call",
        name: "remote_research",
        nodeId: "remoteAgents/research",
        remoteAgentName: "research",
      },
      activityObserver: taskObserver,
      auth: null,
      batchEvent: { sequence: 0, turnId: "parent-turn" },
      bundle: { subagentRegistry: { subagentsByNodeId: new Map() } },
      callbackBaseUrl: "https://parent.example",
      currentSession: { sessionId: "parent-session" },
      initiatorAuth: null,
      originAudience: { kind: "unknown" },
      parentContinuationToken: "parent-token",
      parentTraceContext: undefined,
      session: { sessionId: "parent-session" },
      taskId: "task-1",
    } as never);

    expect(startRemoteAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        activityObserver: {
          sink: taskObserver.sink,
          workIdentity: expect.objectContaining({
            callId: "call-remote",
            kind: "remote-agent",
            name: "research",
            parentId: taskObserver.workIdentity.id,
            rootSessionId: "root-session",
            rootTurnId: "root-turn",
          }),
        },
        taskId: "task-1",
      }),
    );
  });
});
