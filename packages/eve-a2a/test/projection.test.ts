import assert from "node:assert/strict";
import { test } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { applyEvent, initial } from "../extension/lib/projection.ts";
import { taskIdentity } from "../extension/lib/identity.ts";

function event(type: string, data: unknown): MessageStreamEvent {
  return { type, data, meta: { id: "event-1", at: "2026-09-09T00:00:00Z" } } as MessageStreamEvent;
}

test("a task's result stays immutable even if its eve session receives another turn", () => {
  const view = initial("task-1");
  applyEvent(view, event("turn.started", { turnId: "turn-1" }));
  applyEvent(
    view,
    event("message.completed", { finishReason: "tool-calls", message: "Private planning" }),
  );
  assert.equal(JSON.stringify(view.task.artifacts), undefined);
  applyEvent(view, event("message.completed", { finishReason: "stop", message: "First result" }));
  applyEvent(view, event("turn.completed", { turnId: "turn-1" }));
  applyEvent(view, event("turn.started", { turnId: "turn-2" }));
  applyEvent(view, event("message.completed", { finishReason: "stop", message: "Later result" }));
  assert.equal(view.task.status.state, "TASK_STATE_COMPLETED");
  assert.deepEqual(view.task.artifacts?.[0].parts, [{ text: "First result" }]);
});

test("input interrupts the same task until its addressed request is resolved", () => {
  const view = initial("task-1");
  applyEvent(
    view,
    event("input.requested", {
      requests: [{ requestId: "city", kind: "question", prompt: "Which city?" }],
    }),
  );
  assert.equal(view.task.status.state, "TASK_STATE_INPUT_REQUIRED");
  applyEvent(view, event("turn.completed", { turnId: "turn-1" }));
  assert.equal(view.task.status.state, "TASK_STATE_INPUT_REQUIRED");
  applyEvent(view, event("input.resolved", { resolutions: [{ requestId: "unrelated" }] }));
  assert.equal(view.task.status.state, "TASK_STATE_INPUT_REQUIRED");
  applyEvent(view, event("input.resolved", { resolutions: [{ requestId: "city" }] }));
  assert.equal(view.task.status.state, "TASK_STATE_WORKING");
  assert.equal(view.task.id, "task-1");
});

test("task identifiers recover their binding after restart and reject other owners or tampering", () => {
  const issued = taskIdentity("key").issue("session-1", "alice");
  assert.equal(taskIdentity("key").read(issued, "alice"), "session-1");
  assert.throws(() => taskIdentity("key").read(issued, "bob"), /Task not found/);
  assert.throws(() => taskIdentity("different key").read(issued, "alice"), /Task not found/);
  assert.throws(() => taskIdentity("key").read(`x${issued}`, "alice"), /Task not found/);
});

test("execution failures close the task without exposing internal error details", () => {
  const view = initial("task-1");
  applyEvent(view, event("session.failed", { error: "Private infrastructure detail" }));
  applyEvent(view, event("turn.completed", {}));
  assert.equal(view.task.status.state, "TASK_STATE_FAILED");
  assert.deepEqual(view.task.status.message, {
    messageId: "event-1",
    role: "ROLE_AGENT",
    taskId: "task-1",
    contextId: "task-1",
    parts: [{ text: "Agent execution failed" }],
  });
});

test("replaying a workflow answer clears the question when its owning tool settles", () => {
  const view = initial("task-1");
  applyEvent(view, event("actions.requested", { actions: [{ callId: "call-1" }] }));
  applyEvent(
    view,
    event("input.requested", {
      requests: [
        {
          requestId: "city",
          kind: "question",
          prompt: "Which city?",
          action: { callId: "call-1" },
        },
      ],
    }),
  );
  applyEvent(view, event("turn.completed", {}));
  assert.equal(view.task.status.state, "TASK_STATE_INPUT_REQUIRED");
  applyEvent(view, event("action.result", { result: { callId: "call-1" } }));
  applyEvent(view, event("message.completed", { finishReason: "stop", message: "Porto" }));
  applyEvent(view, event("turn.completed", {}));
  assert.equal(view.task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(view.pending.length, 0);
});
