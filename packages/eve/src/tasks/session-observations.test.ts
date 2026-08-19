import { describe, expect, it } from "vitest";

import type { HarnessSession } from "#harness/types.js";
import {
  SESSION_TASK_OBSERVATIONS_STATE_KEY,
  clearObservedReadyTask,
  isObservedReadyTaskDelivery,
  readObservedReadyTasks,
  recordObservedReadyTaskViews,
} from "#tasks/session-observations.js";

const metadata = {
  agentId: "ag_research:abcdef123456",
  kind: "subagent" as const,
  mode: "local" as const,
  name: "research",
};

function createSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "model_test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "continuation_test",
    history: [],
    sessionId: "session_parent",
  };
}

describe("task peek observations", () => {
  it("records ready views and suppresses only their update and matching ready deliveries", () => {
    const observed = recordObservedReadyTaskViews(createSession(), [
      {
        lastOutput: { data: "done", type: "result" },
        metadata,
        status: "completed",
        taskId: "task_a",
      },
    ]);

    expect(readObservedReadyTasks(observed.state)).toEqual({ task_a: "completed" });
    expect(isObservedReadyTaskDelivery(observed.state, "task_a:update:turn:0:call")).toBe(true);
    expect(isObservedReadyTaskDelivery(observed.state, "task_a:ready:completed")).toBe(true);
    expect(isObservedReadyTaskDelivery(observed.state, "task_a:ready:failed")).toBe(false);
    expect(isObservedReadyTaskDelivery(observed.state, "task_b:ready:completed")).toBe(false);
    expect(isObservedReadyTaskDelivery(observed.state, undefined)).toBe(false);
  });

  it("clears an observed input_required view after its answer resumes the task", () => {
    const observed = recordObservedReadyTaskViews(createSession(), [
      {
        inputRequests: [{ requestId: "request-1" }],
        metadata,
        status: "input_required",
        taskId: "task_a",
      },
    ]);
    const cleared = clearObservedReadyTask(observed.state, "task_a");

    expect(readObservedReadyTasks(cleared)).toEqual({});
    expect(isObservedReadyTaskDelivery(cleared, "task_a:update:turn:0:call")).toBe(false);
  });

  it("clears a prior ready observation when a later task_peek returns working", () => {
    const observed = recordObservedReadyTaskViews(createSession(), [
      {
        inputRequests: [{ requestId: "request-1" }],
        metadata,
        status: "input_required",
        taskId: "task_a",
      },
    ]);
    const working = recordObservedReadyTaskViews(observed, [
      { metadata, status: "working", taskId: "task_a" },
    ]);

    expect(working.state?.[SESSION_TASK_OBSERVATIONS_STATE_KEY]).toBeUndefined();
  });

  it("rejects corrupt observation state", () => {
    expect(() =>
      readObservedReadyTasks({ [SESSION_TASK_OBSERVATIONS_STATE_KEY]: { task_a: "working" } }),
    ).toThrow(`Corrupt task observations under session state key`);
  });
});
