import { describe, expect, it } from "vitest";

import type { TaskView } from "#tasks/types.js";

import {
  createTaskRunWorkflowInput,
  migrateTaskRunWorkflowInput,
  TASK_RUN_WORKFLOW_INPUT_VERSION,
} from "./task-run-workflow.js";

describe("task run workflow input migrations", () => {
  it("stamps v1 and dual-writes the current and historical inbox token names", () => {
    expect(
      createTaskRunWorkflowInput({
        initialView: createWorkingView(),
        parentContinuationToken: "parent-token",
        taskInboxToken: "task-token",
      }),
    ).toEqual({
      continuationToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-token",
      taskInboxToken: "task-token",
      version: TASK_RUN_WORKFLOW_INPUT_VERSION,
    });
  });

  it("migrates the historical continuationToken shape without dropping additive fields", () => {
    const input = {
      additiveField: { retained: true },
      continuationToken: "historical-task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-token",
    };

    expect(migrateTaskRunWorkflowInput(input)).toEqual({
      ...input,
      continuationToken: "historical-task-token",
      taskInboxToken: "historical-task-token",
      version: TASK_RUN_WORKFLOW_INPUT_VERSION,
    });
  });

  it("migrates the current pre-version taskInboxToken shape", () => {
    expect(
      migrateTaskRunWorkflowInput({
        initialView: createWorkingView(),
        parentContinuationToken: "parent-token",
        taskInboxToken: "task-token",
      }),
    ).toMatchObject({
      continuationToken: "task-token",
      taskInboxToken: "task-token",
      version: TASK_RUN_WORKFLOW_INPUT_VERSION,
    });
  });

  it("returns current inputs unchanged and rejects newer versions", () => {
    const input = {
      additiveField: "retained",
      continuationToken: "task-token",
      initialView: createWorkingView(),
      parentContinuationToken: "parent-token",
      taskInboxToken: "task-token",
      version: TASK_RUN_WORKFLOW_INPUT_VERSION,
    };

    expect(migrateTaskRunWorkflowInput(input)).toBe(input);
    expect(() => migrateTaskRunWorkflowInput({ version: 2 })).toThrow(
      /task run workflow input: encountered version 2/,
    );
  });

  it("rejects malformed pre-version inputs", () => {
    expect(() => migrateTaskRunWorkflowInput({ taskInboxToken: "task-token" })).toThrow(
      /not a recognized pre-version shape/,
    );
    expect(() =>
      migrateTaskRunWorkflowInput({
        initialView: createWorkingView(),
        parentContinuationToken: "parent-token",
        taskInboxToken: "task-token",
        version: "1",
      }),
    ).toThrow(/has no numeric "version" field/);
  });
});

function createWorkingView(): TaskView {
  return {
    metadata: {
      agentId: "ag_research:abcdef123456",
      kind: "subagent",
      mode: "local",
      name: "research",
    },
    status: "working",
    taskId: "task_abc123",
  };
}
