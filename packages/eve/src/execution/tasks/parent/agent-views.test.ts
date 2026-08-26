import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendTaskAgentAnnouncement,
  readTaskAgentViews,
} from "#execution/tasks/parent/agent-views.js";
import { findActiveTaskForAgent } from "#execution/tasks/parent/control-shared.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/store.js";
import type { HarnessSession } from "#harness/types.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index.js";
import type { TaskStatus, TaskView } from "#tasks/types.js";

vi.mock("#execution/tasks/parent/run-parent.js", () => ({
  readLatestTaskView: vi.fn(),
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
          taskInboxToken: `task-token-${index}`,
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
  // Cast on purpose: mock views omit the per-status payload fields the
  // TaskView union requires (e.g. lastOutput on completed).
  return { metadata, status, taskId } as TaskView;
}

describe("task-derived agent availability", () => {
  beforeEach(() => vi.resetAllMocks());

  it("renders a nonterminal task as busy and a terminal task as available", async () => {
    vi.mocked(readLatestTaskView)
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

  it("finds the active task used for the continuation availability check", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue(task("task_0", "input_required"));

    await expect(
      findActiveTaskForAgent(createSession(["run-0"]), metadata.agentId),
    ).resolves.toMatchObject({
      view: { status: "input_required", taskId: "task_0" },
    });
  });

  it("appends the busy projection without exposing routing coordinates", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue(task("task_0", "working"));

    const next = await appendTaskAgentAnnouncement(createSession(["run-0"]));
    const message = next.history.at(-1);
    const announcement = message?.content;

    expect(message?.role).toBe("user");
    expect(announcement).toContain('availability="busy"');
    expect(announcement).toContain('taskId="task_0"');
    expect(announcement).not.toContain("child-token");
    expect(announcement).not.toContain("child-session");
    await expect(appendTaskAgentAnnouncement(next)).resolves.toBe(next);
  });

  it("combines parked blocking and addressed background agents", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue(task("task_0", "working"));
    const session = createSession(["run-0"]);
    const handles = (session.state![AGENT_HANDLES_STATE_KEY] as { handles: unknown[] }).handles;
    const withBlocking = {
      ...session,
      state: {
        ...session.state,
        [AGENT_HANDLES_STATE_KEY]: {
          handles: [
            {
              address: {
                continuationToken: "blocking-token",
                kind: "agent/local",
                sessionId: "blocking-session",
              },
              identity: {
                execution: "blocking",
                id: "ag_writer:abcdef123456",
                name: "writer",
                nodeId: "node-writer",
                targetKind: "local",
              },
              lastStatus: "draft ready",
              phase: "parked",
            },
            ...handles,
          ],
        },
      },
    };

    const next = await appendTaskAgentAnnouncement(withBlocking);
    const announcement = String(next.history.at(-1)?.content);

    expect(announcement).toContain('id="ag_writer:abcdef123456"');
    expect(announcement).toContain("draft ready");
    expect(announcement).toContain(`id="${metadata.agentId}"`);
    expect(announcement).toContain('taskId="task_0"');
  });

  it("deduplicates task announcements against the prepared history view", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue(task("task_0", "working"));
    const session = createSession(["run-0"]);
    const withRawAnnouncement = await appendTaskAgentAnnouncement(session);

    const next = await appendTaskAgentAnnouncement(withRawAnnouncement, []);

    expect(next.history).toHaveLength(withRawAnnouncement.history.length + 1);
    expect(next.history.at(-1)).toEqual(withRawAnnouncement.history.at(-1));
  });

  it("rejects two nonterminal tasks bound to one child agent", async () => {
    vi.mocked(readLatestTaskView)
      .mockResolvedValueOnce(task("task_0", "working"))
      .mockResolvedValueOnce(task("task_1", "input_required"));

    await expect(readTaskAgentViews(createSession(["run-0", "run-1"]))).rejects.toThrow(
      "more than one nonterminal task",
    );
  });
});
