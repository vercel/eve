import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { settleDelegatedDispatch, type DelegatedTask } from "#execution/tasks/delegate.js";
import { sendTaskCommandToOwner } from "#execution/tasks/run-control.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";

vi.mock("#execution/tasks/run-control.js", () => ({
  sendTaskCommandToOwner: vi.fn(),
}));

describe("delegated task settlement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sendTaskCommandToOwner).mockResolvedValue({ runId: "run-owner" });
  });

  it("indexes the command-hook owner after the readiness barrier", async () => {
    const session = {
      agent: { modelReference: { id: "model" }, system: "", tools: [] },
      compaction: { recentWindowSize: 4, threshold: 1_000_000 },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
    } as RuntimeSession;
    const task: DelegatedTask = {
      commandToken: "task-token",
      createdByTurnId: "turn-parent",
      metadata: {
        agentId: "agent-1",
        kind: "subagent",
        mode: "local",
        name: "research",
      },
      operationId: "operation-1",
      taskId: "task-1",
      taskRunId: "run-candidate",
    };

    const result = await settleDelegatedDispatch({
      callId: "call-task",
      session,
      subagentName: "research",
      task,
    });

    expect(sendTaskCommandToOwner).toHaveBeenCalledWith(
      expect.objectContaining({ command: { kind: "ready" } }),
    );
    expect(getSessionTaskIndex(result.session.state)[0]).toMatchObject({
      taskId: "task-1",
      taskRunId: "run-owner",
    });
  });
});
