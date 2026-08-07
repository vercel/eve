import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  acknowledgeDelegatedTasksStep,
  settleDelegatedDispatch,
  type DelegatedTask,
} from "#execution/tasks/delegate.js";
import { sendTaskCommandToOwner } from "#execution/tasks/run-control.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";

vi.mock("#execution/tasks/run-control.js", () => ({
  readLatestTaskSnapshot: vi.fn(),
  sendTaskCommandToOwner: vi.fn(),
}));

describe("delegated task settlement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sendTaskCommandToOwner).mockResolvedValue({ runId: "run-owner" });
  });

  it("indexes the resolved command-hook owner before readiness", async () => {
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

    expect(sendTaskCommandToOwner).not.toHaveBeenCalled();
    expect(getSessionTaskIndex(result.session.state)[0]).toMatchObject({
      taskId: "task-1",
      taskRunId: "run-candidate",
    });

    await acknowledgeDelegatedTasksStep({ tasks: [task] });
    expect(sendTaskCommandToOwner).toHaveBeenCalledWith(
      expect.objectContaining({ command: { kind: "ready" } }),
    );
  });
});
