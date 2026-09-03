import { describe, expect, it } from "vitest";

import { taskCancel } from "#tools/framework/task-cancel.js";
import { TASK_VIEWS_OUTPUT_SCHEMA } from "#tools/framework/task-contract.js";
import { taskViewToJson } from "#tasks/json.js";
import type { TaskView } from "#tasks/types.js";

describe("taskViewToJson", () => {
  it("projects only the model-visible task fields", () => {
    const view: TaskView = {
      executor: {
        binding: { data: { runId: "run-1" }, kind: "workflow-tool" },
      },
      lastOutput: { data: { answer: 42 }, type: "result" },
      metadata: {
        agentId: "agent-1",
        kind: "subagent",
        mode: "remote",
        name: "researcher",
      },
      state: { progress: 1 },
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
        mode: "remote",
        name: "researcher",
      },
      state: { progress: 1 },
      status: "completed",
      taskId: "task-1",
    });
  });
});

describe("taskCancel.outputSchema", () => {
  it("preserves the broad task-control output contract", () => {
    expect(taskCancel.outputSchema).toBe(TASK_VIEWS_OUTPUT_SCHEMA);
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
