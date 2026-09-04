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

  it("moves through input, answer, and completion", () => {
    const blocked = applyTaskTransition(view("working"), {
      inputRequests: [{ prompt: "Continue?", requestId: "req-1" }],
      kind: "require-input",
    });
    expect(blocked).toMatchObject({ action: "accepted", view: { status: "input_required" } });
    const resumed = applyTaskTransition(blocked.view, { kind: "answered", requestIds: ["req-1"] });
    expect(resumed).toMatchObject({ action: "accepted", view: { status: "working" } });
    const completed = applyTaskTransition(resumed.view, { data: { answer: 42 }, kind: "complete" });
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
    expect(applyTaskTransition(cancelled.view, { data: "late", kind: "complete" }).action).toBe(
      "rejected",
    );
  });
});
