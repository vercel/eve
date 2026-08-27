import { describe, expect, it } from "vitest";

import { toClientTaskView } from "#tasks/client.js";
import type { TaskView } from "#tasks/types.js";

describe("client task projection", () => {
  it("removes private executor routing while retaining public state", () => {
    const view: TaskView = {
      executor: {
        childSessionId: "child_1",
        childTurnId: "turn_1",
        lifecycle: "parked",
      },
      lastOutput: { data: { message: "done" }, type: "result" },
      metadata: {
        agentId: "agent_1",
        kind: "subagent",
        mode: "local",
        name: "research",
      },
      status: "completed",
      taskId: "task_1",
      usage: {
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        inputTokens: 10,
        outputTokens: 5,
      },
    };

    expect(toClientTaskView(view)).toEqual({
      lastOutput: { data: { message: "done" }, type: "result" },
      metadata: {
        agentId: "agent_1",
        kind: "subagent",
        mode: "local",
        name: "research",
      },
      status: "completed",
      taskId: "task_1",
      usage: {
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        inputTokens: 10,
        outputTokens: 5,
      },
    });
  });
});
