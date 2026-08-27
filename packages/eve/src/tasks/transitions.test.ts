import { describe, expect, it } from "vitest";

import { applyTaskTransition } from "#tasks/transitions.js";
import type { TaskCommand, TaskStatus, TaskView } from "#tasks/types.js";

function createView(status: TaskStatus, overrides: Partial<TaskView> = {}): TaskView {
  // Cast on purpose: tests probe the transition function's runtime guards
  // with shapes the TaskView union already forbids (e.g. terminal, no output).
  return {
    metadata: {
      agentId: "ag_research:abcdef123456",
      kind: "subagent",
      mode: "local",
      name: "research",
    },
    status,
    taskId: "task_abc123",
    ...overrides,
  } as TaskView;
}

const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];
const ALL_COMMANDS: readonly TaskCommand[] = [
  {
    executor: { data: { operationId: "operation-1" }, kind: "export" },
    kind: "bind",
  },
  { data: { answer: 42 }, kind: "complete" },
  { data: { message: "boom" }, kind: "fail" },
  { data: { message: "unindexed" }, kind: "reject-dispatch" },
  {
    callId: "call-1",
    hookToken: "run-hook",
    kind: "bind-relay",
    runId: "relay-run",
    toolName: "research",
  },
  { kind: "cancel" },
  { kind: "require-authorization", requestId: "auth-1" },
  { inputRequests: [{ question: "which?" }], kind: "require-input" },
  { kind: "ready" },
  { kind: "answered", requestIds: ["req-1"] },
];

describe("applyTaskTransition", () => {
  it("binds one replay-stable workflow relay", () => {
    const working = createView("working");
    const command = {
      callId: "call-1",
      hookToken: "run-hook",
      kind: "bind-relay" as const,
      runId: "relay-run",
      toolName: "research",
    };

    const bound = applyTaskTransition(working, command);

    expect(bound).toMatchObject({
      action: "accepted",
      view: {
        executor: {
          binding: {
            kind: "subagent-relay",
            data: {
              callId: command.callId,
              hookToken: command.hookToken,
              runId: command.runId,
              toolName: command.toolName,
            },
          },
        },
      },
    });
    expect(applyTaskTransition(bound.view, command).action).toBe("noop");
  });

  it("binds an opaque executor binding idempotently", () => {
    const command = {
      executor: { data: { operationId: "operation-1" }, kind: "export" },
      kind: "bind",
    } as const;

    const bound = applyTaskTransition(createView("working"), command);
    expect(bound).toMatchObject({
      action: "accepted",
      view: {
        executor: { binding: command.executor },
        metadata: createView("working").metadata,
        status: "working",
      },
    });
    expect(applyTaskTransition(bound.view, command)).toEqual({
      action: "noop",
      view: bound.view,
    });
    expect(
      applyTaskTransition(bound.view, {
        executor: { data: { operationId: "operation-2" }, kind: "export" },
        kind: "bind",
      }),
    ).toMatchObject({ action: "rejected", view: bound.view });
  });

  it("retains a late executor binding after fast task completion", () => {
    const completed = applyTaskTransition(createView("working"), {
      data: { answer: 42 },
      kind: "complete",
    });
    const executor = { data: { operationId: "operation-1" }, kind: "export" };

    const bound = applyTaskTransition(completed.view, { executor, kind: "bind" });

    expect(bound).toMatchObject({
      action: "accepted",
      view: {
        executor: { binding: executor },
        lastOutput: { data: { answer: 42 }, type: "result" },
        status: "completed",
      },
    });
  });

  it("completes a working task with a result output", () => {
    const result = applyTaskTransition(createView("working"), {
      data: { answer: 42 },
      kind: "complete",
    });

    expect(result.action).toBe("accepted");
    expect(result.view.status).toBe("completed");
    expect(result.view.lastOutput).toEqual({ data: { answer: 42 }, type: "result" });
  });

  it("retains reported child usage on the terminal view only", () => {
    const usage = { cacheReadTokens: 1, cacheWriteTokens: 2, inputTokens: 300, outputTokens: 40 };
    for (const command of [
      { data: "done", kind: "complete", usage },
      { data: "boom", kind: "fail", usage },
      { kind: "cancel", usage },
    ] as const) {
      const result = applyTaskTransition(createView("working"), command);
      expect(result.action).toBe("accepted");
      expect(result.view.usage).toEqual(usage);
    }

    const withoutUsage = applyTaskTransition(createView("working"), {
      data: "done",
      kind: "complete",
    });
    expect(withoutUsage.view.usage).toBeUndefined();

    const blocked = applyTaskTransition(createView("working"), {
      inputRequests: [{ question: "which?", requestId: "req-1" }],
      kind: "require-input",
    });
    expect(blocked.view.usage).toBeUndefined();
  });

  it("fails a working task and carries the error as its output", () => {
    const result = applyTaskTransition(createView("working"), {
      data: { message: "boom" },
      kind: "fail",
    });

    expect(result.action).toBe("accepted");
    expect(result.view.status).toBe("failed");
    expect(result.view.lastOutput).toEqual({ data: { message: "boom" }, type: "error" });
  });

  it("moves working to input_required carrying the outstanding batch", () => {
    const result = applyTaskTransition(createView("working"), {
      inputRequests: [{ question: "which region?", requestId: "req-1" }],
      kind: "require-input",
    });

    expect(result.action).toBe("accepted");
    expect(result.view.status).toBe("input_required");
    expect(result.view.inputRequests).toEqual([{ question: "which region?", requestId: "req-1" }]);
  });

  it("rejects empty, unidentified, and duplicate input request batches", () => {
    for (const inputRequests of [
      [],
      [{ question: "missing id" }],
      [
        { question: "first", requestId: "same" },
        { question: "second", requestId: "same" },
      ],
    ]) {
      const result = applyTaskTransition(createView("working"), {
        inputRequests,
        kind: "require-input",
      });
      expect(result.action).toBe("rejected");
      expect(result.view.status).toBe("working");
    }
  });

  it("returns input_required to working once the whole batch is answered", () => {
    const blocked = applyTaskTransition(createView("working"), {
      inputRequests: [{ question: "which region?", requestId: "req-1" }],
      kind: "require-input",
    });
    expect(blocked.action).toBe("accepted");

    const result = applyTaskTransition(blocked.view, { kind: "answered", requestIds: ["req-1"] });

    expect(result.action).toBe("accepted");
    expect(result.view.status).toBe("working");
    expect(result.view.inputRequests).toBeUndefined();
  });

  it("keeps the task blocked on the remainder of a partly answered batch", () => {
    const blocked = applyTaskTransition(createView("working"), {
      inputRequests: [
        { question: "which region?", requestId: "req-1" },
        { question: "which size?", requestId: "req-2" },
      ],
      kind: "require-input",
    });
    expect(blocked.action).toBe("accepted");

    const result = applyTaskTransition(blocked.view, { kind: "answered", requestIds: ["req-1"] });

    expect(result.action).toBe("accepted");
    expect(result.view.status).toBe("input_required");
    expect(result.view.inputRequests).toEqual([{ question: "which size?", requestId: "req-2" }]);
  });

  it("ignores an answer to a batch that was already replaced", () => {
    const first = applyTaskTransition(createView("working"), {
      inputRequests: [{ question: "first", requestId: "req-1" }],
      kind: "require-input",
    });
    const second = applyTaskTransition(first.view, {
      inputRequests: [{ question: "second", requestId: "req-2" }],
      kind: "require-input",
    });
    expect(second.action).toBe("accepted");

    const stale = applyTaskTransition(second.view, { kind: "answered", requestIds: ["req-1"] });

    expect(stale.action).toBe("noop");
    expect(stale.view.status).toBe("input_required");
    expect(stale.view.inputRequests).toEqual([{ question: "second", requestId: "req-2" }]);
  });

  it("keeps independent authorization attempts blocked until each completes", () => {
    const first = applyTaskTransition(createView("working"), {
      kind: "require-authorization",
      requestId: "auth-1",
    });
    const second = applyTaskTransition(first.view, {
      kind: "require-authorization",
      requestId: "auth-2",
    });
    const completedFirst = applyTaskTransition(second.view, {
      kind: "answered",
      requestIds: ["auth-1"],
    });

    expect(second.view).toMatchObject({
      inputRequests: [
        { blockedOn: "authorization", requestId: "auth-1" },
        { blockedOn: "authorization", requestId: "auth-2" },
      ],
      status: "input_required",
    });
    expect(completedFirst.view).toMatchObject({
      inputRequests: [{ blockedOn: "authorization", requestId: "auth-2" }],
      status: "input_required",
    });
  });

  it("replaces the outstanding batch on repeated require-input", () => {
    const first = applyTaskTransition(createView("working"), {
      inputRequests: [{ question: "first", requestId: "req-1" }],
      kind: "require-input",
    });
    expect(first.action).toBe("accepted");

    const second = applyTaskTransition(first.view, {
      inputRequests: [{ question: "second", requestId: "req-2" }],
      kind: "require-input",
    });

    expect(second.action).toBe("accepted");
    expect(second.view.inputRequests).toEqual([{ question: "second", requestId: "req-2" }]);
  });

  it("completes and cancels an input_required task", () => {
    const blocked = applyTaskTransition(createView("working"), {
      inputRequests: [{ question: "which?", requestId: "req-1" }],
      kind: "require-input",
    });
    expect(blocked.action).toBe("accepted");

    const completed = applyTaskTransition(blocked.view, { data: "done", kind: "complete" });
    expect(completed.action).toBe("accepted");
    expect(completed.view.status).toBe("completed");

    const cancelled = applyTaskTransition(blocked.view, { kind: "cancel" });
    expect(cancelled.action).toBe("accepted");
    expect(cancelled.view.status).toBe("cancelled");
  });

  it("treats an answer to a working task as a noop", () => {
    const result = applyTaskTransition(createView("working"), {
      kind: "answered",
      requestIds: ["req-1"],
    });

    expect(result.action).toBe("noop");
    expect(result.view.status).toBe("working");
  });

  it("rejects a late completion after cancellation", () => {
    const cancelled = applyTaskTransition(createView("working"), { kind: "cancel" });
    expect(cancelled.action).toBe("accepted");

    const late = applyTaskTransition(cancelled.view, { data: "too late", kind: "complete" });

    expect(late.action).toBe("rejected");
    expect(late.view.status).toBe("cancelled");
    expect(late.view.lastOutput).toBeUndefined();
  });

  it("treats repeated cancellation as an idempotent noop", () => {
    const cancelled = applyTaskTransition(createView("working"), { kind: "cancel" });
    expect(cancelled.action).toBe("accepted");

    const again = applyTaskTransition(cancelled.view, { kind: "cancel" });

    expect(again.action).toBe("noop");
    expect(again.view.status).toBe("cancelled");
  });

  it.each(TERMINAL_STATUSES)("keeps %s final against every lifecycle command", (status) => {
    const view = createView(status);
    for (const command of ALL_COMMANDS) {
      if (command.kind === "bind" || command.kind === "bind-relay") continue;
      if (command.kind === "cancel" && status === "cancelled") continue;
      const result = applyTaskTransition(view, command);
      expect(result.action).toBe("rejected");
      expect(result.view).toBe(view);
    }
  });

  it("rejects cancel on completed and failed tasks", () => {
    for (const status of ["completed", "failed"] as const) {
      const result = applyTaskTransition(createView(status), { kind: "cancel" });
      expect(result.action).toBe("rejected");
    }
  });

  it("is deterministic for replayed commands", () => {
    const view = createView("working");
    const command: TaskCommand = { data: { answer: 1 }, kind: "complete" };

    const first = applyTaskTransition(view, command);
    const second = applyTaskTransition(view, command);

    expect(first).toEqual(second);
  });

  it("never rebinds a task turn to a different child session", () => {
    const result = applyTaskTransition(
      createView("working", {
        executor: { childSessionId: "child-session-1" },
        metadata: {
          agentId: "ag_research:abcdef123456",
          kind: "subagent",
          mode: "local",
          name: "research",
        },
      }),
      {
        childSessionId: "other-child",
        childTurnId: "turn_9",
        kind: "start-turn",
        taskId: "task_abc123",
      },
    );

    expect(result.action).toBe("rejected");
    expect(result.view.executor?.childSessionId).toBe("child-session-1");
  });

  it("retains late usage on a terminal task without reviving it", () => {
    const usage = { cacheReadTokens: 1, cacheWriteTokens: 2, inputTokens: 300, outputTokens: 40 };
    const cancelled = applyTaskTransition(createView("working"), { kind: "cancel" });
    if (cancelled.action !== "accepted") throw new Error("Expected cancellation to commit.");

    const result = applyTaskTransition(cancelled.view, { kind: "settle-executor", usage });

    expect(result).toEqual({
      action: "accepted",
      view: { ...cancelled.view, executor: { lifecycle: "terminal" }, usage },
    });
  });

  it("settles the relay release barrier on forced cancellation", () => {
    const working = createView("working", {
      executor: {
        binding: {
          data: {
            callId: "call-1",
            hookToken: "relay-hook",
            runId: "relay-run",
            toolName: "research",
          },
          kind: "subagent-relay",
        },
      },
    });
    const cancelled = applyTaskTransition(working, { kind: "cancel" });
    if (cancelled.action !== "accepted") throw new Error("Expected cancellation to commit.");

    const settled = applyTaskTransition(cancelled.view, { kind: "settle-executor" });

    expect(settled).toMatchObject({
      action: "accepted",
      view: {
        executor: {
          binding: { data: { released: true }, kind: "subagent-relay" },
          lifecycle: "terminal",
        },
      },
    });
  });
});
