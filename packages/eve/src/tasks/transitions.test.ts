import type { JsonValue } from "#shared/json.js";
import { describe, expect, it } from "vitest";

import { applyTaskTransition } from "#tasks/transitions.js";
import type { TaskStatus, TaskView } from "#tasks/types.js";

function view(status: TaskStatus, overrides: Partial<TaskView> = {}): TaskView {
  return {
    metadata: { kind: "tool", name: "export" },
    status,
    taskId: "task-1",
    ...overrides,
  } as TaskView;
}

describe("applyTaskTransition", () => {
  it("moves through input, answer, and completion", () => {
    const blocked = applyTaskTransition(view("working"), {
      inputRequests: [{ prompt: "Continue?", requestId: "req-1" }],
      kind: "require-input",
    });
    expect(blocked).toMatchObject({ action: "accepted", view: { status: "input_required" } });
    const resumed = applyTaskTransition(blocked.view, { kind: "answered", requestIds: ["req-1"] });
    expect(resumed).toMatchObject({ action: "accepted", view: { status: "working" } });
    const completed = applyTaskTransition(resumed.view, outcome({ answer: 42 }));
    expect(completed).toMatchObject({
      action: "accepted",
      view: { lastOutput: { data: { answer: 42 }, type: "result" }, status: "completed" },
    });
  });

  it("rejects malformed input batches", () => {
    for (const inputRequests of [
      [],
      [{ prompt: "missing id" }],
      [{ requestId: "same" }, { requestId: "same" }],
    ]) {
      expect(
        applyTaskTransition(view("working"), { inputRequests, kind: "require-input" }).action,
      ).toBe("rejected");
    }
  });

  it("keeps terminal states final and cancellation idempotent", () => {
    const cancelled = applyTaskTransition(view("working"), { kind: "cancel" });
    expect(cancelled).toMatchObject({ action: "accepted", view: { status: "cancelled" } });
    expect(applyTaskTransition(cancelled.view, { kind: "cancel" }).action).toBe("noop");
    expect(applyTaskTransition(cancelled.view, outcome("late")).action).toBe("rejected");
  });
});

function outcome(output: JsonValue) {
  return {
    kind: "outcome" as const,
    result: { status: "completed" as const, output },
    from: {
      callId: "call",
      execution: "background" as const,
      input: {},
      runId: "run",
      sequence: 0,
      stepIndex: 0,
      toolName: "export",
      turnId: "turn",
    },
  };
}
