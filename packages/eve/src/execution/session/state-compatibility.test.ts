import { describe, expect, it } from "vitest";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { isSessionStateIdleForHandoff } from "#execution/session/handoff-steps.js";
import {
  cacheTerminalTaskView,
  getSessionTaskIndex,
  recordSessionTask,
} from "#tasks/session-index.js";
import { parseActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { HarnessSession } from "#harness/types.js";

const metadata = { kind: "tool", name: "research" };
const activity = {
  id: "work",
  kind: "task" as const,
  rootSessionId: "root",
  rootTurnId: "turn",
  futureActivity: { label: "Alice's research" },
};
const task = {
  taskId: "task",
  taskRunId: "run",
  taskInboxToken: "inbox",
  createdByTurnId: "turn",
  metadata,
  activityWorkIdentity: activity,
  futureTask: { revision: 2 },
  executor: { kind: "workflow", data: {}, futureExecutor: true },
  terminalView: {
    taskId: "task",
    metadata,
    status: "completed" as const,
    lastOutput: { type: "result" as const, data: "done", futureOutput: true },
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      futureUsage: true,
    },
    executor: {
      futureExecutor: true,
      binding: { kind: "workflow", data: {}, futureBinding: true },
    },
    futureView: true,
  },
};
function checkpoint(state: Record<string, unknown>) {
  const value = createTestSessionState();
  return { ...value, snapshot: { session: { ...value.snapshot.session, state } } };
}
function session(state: Record<string, unknown>): HarnessSession {
  return {
    agent: { modelReference: { id: "model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "token",
    history: [],
    sessionId: "session",
    state,
  };
}
const restored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("additive durable state", () => {
  it("preserves task extensions through parsing, replayed creation and terminal updates", () => {
    const state = {
      "eve.tasks": { version: 2, tasks: [task], futureIndex: true },
      authored: { opaque: true },
    };
    expect(getSessionTaskIndex(restored(state))).toEqual([task]);
    expect(parseActivityWorkIdentityV1(activity)).toEqual(activity);
    const updated = recordSessionTask(session(restored(state)), {
      taskId: "task",
      taskRunId: "new-run",
      taskInboxToken: "inbox",
      createdByTurnId: "turn",
      metadata,
      activityWorkIdentity: { id: "work", kind: "task", rootSessionId: "root", rootTurnId: "turn" },
      executor: { kind: "workflow", data: {} },
    });
    const saved = cacheTerminalTaskView(updated.state, {
      taskId: "task",
      metadata,
      status: "completed",
      lastOutput: { type: "result", data: "updated" },
      usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executor: { binding: { kind: "workflow", data: {} } },
    });
    expect(restored(saved)).toMatchObject({
      authored: { opaque: true },
      "eve.tasks": {
        futureIndex: true,
        tasks: [
          {
            futureTask: { revision: 2 },
            taskRunId: "new-run",
            activityWorkIdentity: activity,
            executor: { futureExecutor: true },
            terminalView: {
              futureView: true,
              lastOutput: { data: "updated", futureOutput: true },
              usage: { inputTokens: 3, futureUsage: true },
              executor: { futureExecutor: true, binding: { futureBinding: true } },
            },
          },
        ],
      },
    });
    expect(isSessionStateIdleForHandoff(checkpoint(restored(saved!)))).toBe(true);
    const cancelled = cacheTerminalTaskView(saved, {
      taskId: "task",
      metadata,
      status: "cancelled",
    });
    expect(getSessionTaskIndex(restored(cancelled))[0]?.terminalView).toMatchObject({
      futureView: true,
      status: "cancelled",
    });
    expect(getSessionTaskIndex(restored(cancelled))[0]?.terminalView?.lastOutput).toBeUndefined();
  });
});

describe("handoff state inspection", () => {
  it("accepts additive framework metadata and opaque authored state", () => {
    expect(
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.tasks": { version: 2, tasks: [task], futureIndex: true },
          "eve.agent.handles": { handles: [], futureStore: true },
          authored: { version: "anything", values: [null, false] },
        }),
      ),
    ).toBe(true);
  });
  it("parses settled entries before checking their terminal status", () => {
    const incompatible = { ...task, taskInboxToken: 42 };
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({ "eve.tasks": { version: 2, tasks: [incompatible] } }),
      ),
    ).toThrow("Corrupt task index");
  });
  it("does not skip task parsing when another registry is busy", () => {
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.runtime.pendingAuthorization": {},
          "eve.tasks": { version: 2, tasks: [{ ...task, taskRunId: null }] },
        }),
      ),
    ).toThrow("Corrupt task index");
  });
  it.each([
    ["eve.runtime.pendingAuthorization", false],
    ["eve.runtime.pendingInputBatch", {}],
    ["eve.runtime.pendingInputBatches", [null]],
    ["eve.runtime.pendingCoordinationBatch", {}],
    ["eve.runtime.workflowToolRuns", {}],
    ["eve.runtime.deferredStepInput", {}],
    ["eve.harness.pendingWorkflowInterrupt", {}],
    ["eve.runtime.proxyInputRequests", { malformed: null }],
  ])("refuses nonempty or unreadable pending work in %s", (key, value) => {
    expect(isSessionStateIdleForHandoff(checkpoint({ [key]: value }))).toBe(false);
  });
});
