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
  it("binds one opaque executor idempotently", () => {
    const command = {
      executor: { data: { runId: "run-1" }, kind: "workflow-tool" },
      kind: "bind",
    } as const;
    const bound = applyTaskTransition(view("working"), command);
    expect(bound).toMatchObject({
      action: "accepted",
      view: { executor: { binding: command.executor } },
    });
    expect(applyTaskTransition(bound.view, command).action).toBe("noop");
    expect(
      applyTaskTransition(bound.view, {
        executor: { data: { runId: "run-2" }, kind: "workflow-tool" },
        kind: "bind",
      }).action,
    ).toBe("rejected");
  });

  it("retains a late binding after fast completion", () => {
    const completed = applyTaskTransition(view("working"), { data: "done", kind: "complete" });
    const bound = applyTaskTransition(completed.view, {
      executor: { data: { runId: "run-1" }, kind: "workflow-tool" },
      kind: "bind",
    });
    expect(bound).toMatchObject({ action: "accepted", view: { status: "completed" } });
  });

  it("stores author state across input and completion", () => {
    const stored = applyTaskTransition(view("working"), {
      kind: "set-state",
      state: { progress: 0.5 },
    });
    expect(stored).toMatchObject({
      action: "accepted",
      view: { state: { progress: 0.5 }, status: "working" },
    });
    expect(
      applyTaskTransition(stored.view, { kind: "set-state", state: { progress: 0.5 } }).action,
    ).toBe("noop");

    const blocked = applyTaskTransition(stored.view, {
      inputRequests: [{ prompt: "Continue?", requestId: "req-1" }],
      kind: "require-input",
    });
    expect(blocked).toMatchObject({
      action: "accepted",
      view: { state: { progress: 0.5 }, status: "input_required" },
    });
    const resumed = applyTaskTransition(blocked.view, { kind: "answered", requestIds: ["req-1"] });
    expect(resumed).toMatchObject({
      action: "accepted",
      view: { state: { progress: 0.5 }, status: "working" },
    });
    const completed = applyTaskTransition(resumed.view, { data: { answer: 42 }, kind: "complete" });
    expect(completed).toMatchObject({
      action: "accepted",
      view: {
        lastOutput: { data: { answer: 42 }, type: "result" },
        state: { progress: 0.5 },
        status: "completed",
      },
    });
    expect(
      applyTaskTransition(completed.view, { kind: "set-state", state: { progress: 1 } }).action,
    ).toBe("rejected");
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
    expect(applyTaskTransition(cancelled.view, { data: "late", kind: "complete" }).action).toBe(
      "rejected",
    );
  });
});
