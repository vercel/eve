import { beforeEach, describe, expect, it, vi } from "vitest";

import { appendTaskAgentAnnouncement, readTaskAgentViews } from "#execution/tasks/agent-views.js";
import { findActiveTaskForAgent } from "#execution/tasks/control-shared.js";
import { readLatestTaskSnapshot } from "#execution/tasks/run-control.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/store.js";
import type { HarnessSession } from "#harness/types.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index.js";
import type { TaskStatus, TaskView } from "#tasks/types.js";

vi.mock("#execution/tasks/run-control.js", () => ({
  readLatestTaskSnapshot: vi.fn(),
}));

const metadata = {
  agentId: "ag_research:abcdef123456",
  kind: "subagent" as const,
  mode: "local" as const,
  name: "research",
};

function createSession(taskRunIds: readonly string[]): HarnessSession {
  return {
    agent: { modelReference: { id: "model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
    state: {
      [AGENT_HANDLES_STATE_KEY]: {
        handles: [
          {
            address: {
              continuationToken: "child-token",
              kind: "agent/local",
              sessionId: "child-session",
            },
            identity: { id: metadata.agentId, name: metadata.name, nodeId: "node-research" },
            phase: "addressed",
          },
        ],
      },
      [SESSION_TASKS_STATE_KEY]: {
        tasks: taskRunIds.map((taskRunId, index) => ({
          commandToken: `task-token-${index}`,
          createdByTurnId: `turn-${index}`,
          metadata,
          operationId: `operation-${index}`,
          taskId: `task_${index}`,
          taskRunId,
        })),
      },
    },
  };
}

function task(taskId: string, status: TaskStatus): TaskView {
  return { metadata, status, taskId };
}

describe("task-derived agent availability", () => {
  beforeEach(() => vi.resetAllMocks());

  it("renders a nonterminal task as busy and a terminal task as available", async () => {
    vi.mocked(readLatestTaskSnapshot)
      .mockResolvedValueOnce(task("task_0", "working"))
      .mockResolvedValueOnce(task("task_0", "completed"));
    const session = createSession(["run-0"]);

    await expect(readTaskAgentViews(session)).resolves.toEqual([
      {
        availability: "busy",
        id: metadata.agentId,
        name: metadata.name,
        statusLine: undefined,
        taskId: "task_0",
        taskStatus: "working",
      },
    ]);
    await expect(readTaskAgentViews(session)).resolves.toEqual([
      {
        availability: "available",
        id: metadata.agentId,
        name: metadata.name,
        statusLine: undefined,
      },
    ]);
  });

  it("finds the active task used for continuation admission", async () => {
    vi.mocked(readLatestTaskSnapshot).mockResolvedValue(task("task_0", "input_required"));

    await expect(
      findActiveTaskForAgent(createSession(["run-0"]), metadata.agentId),
    ).resolves.toMatchObject({
      view: { status: "input_required", taskId: "task_0" },
    });
  });

  it("appends the busy projection without exposing routing coordinates", async () => {
    vi.mocked(readLatestTaskSnapshot).mockResolvedValue(task("task_0", "working"));

    const next = await appendTaskAgentAnnouncement(createSession(["run-0"]));
    const announcement = next.history.at(-1)?.content;

    expect(announcement).toContain('availability="busy"');
    expect(announcement).toContain('taskId="task_0"');
    expect(announcement).not.toContain("child-token");
    expect(announcement).not.toContain("child-session");
  });

  it("rejects two nonterminal tasks bound to one child agent", async () => {
    vi.mocked(readLatestTaskSnapshot)
      .mockResolvedValueOnce(task("task_0", "working"))
      .mockResolvedValueOnce(task("task_1", "input_required"));

    await expect(readTaskAgentViews(createSession(["run-0", "run-1"]))).rejects.toThrow(
      "more than one nonterminal task",
    );
  });
});
