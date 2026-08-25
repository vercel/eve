import { describe, expect, it } from "vitest";

import { TASK_VIEWS_OUTPUT_SCHEMA } from "#shared/task-tool.js";
import { taskViewToJson } from "#tasks/json.js";
import type { TaskView } from "#tasks/types.js";

describe("taskViewToJson", () => {
  it("projects only the model-visible task fields", () => {
    const view: TaskView = {
      executor: {
        childSessionId: "child-session-1",
        childTurnId: "child-turn-1",
        lifecycle: "terminal",
      },
      lastOutput: { data: { answer: 42 }, type: "result" },
      metadata: {
        agentId: "agent-1",
        kind: "subagent",
        mode: "local",
        name: "researcher",
      },
      status: "completed",
      taskId: "task-1",
      usage: {
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        inputTokens: 3,
        outputTokens: 4,
      },
    };

    expect(taskViewToJson(view)).toEqual({
      lastOutput: { data: { answer: 42 }, type: "result" },
      metadata: {
        agentId: "agent-1",
        kind: "subagent",
        mode: "local",
        name: "researcher",
      },
      status: "completed",
      taskId: "task-1",
    });
  });
});

describe("TASK_VIEWS_OUTPUT_SCHEMA", () => {
  it("preserves the broad task-control output contract", () => {
    expect(
      TASK_VIEWS_OUTPUT_SCHEMA.parse({
        tasks: [
          {
            inputRequests: [{ prompt: "Choose" }],
            lastOutput: { data: "partial", type: "result" },
            metadata: { data: { source: "custom" }, kind: "tool", name: "report" },
            status: "working",
            taskId: "task-1",
          },
        ],
      }),
    ).toMatchObject({ tasks: [{ status: "working", taskId: "task-1" }] });
  });
});
