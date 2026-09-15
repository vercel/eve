import { describe, expect, it } from "vitest";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { isSessionStateIdleForHandoff } from "#execution/session-handoff-steps.js";
import {
  cacheTerminalTaskView,
  getSessionTaskIndex,
  recordSessionTask,
} from "#tasks/session-index.js";
import { parseActivityWorkIdentityV1 } from "#protocol/activity.js";
import {
  getAgentHandleStore,
  parseAgentHandleStoreCommand,
  setAgentHandleStore,
} from "#subagents/handles/store.js";
import {
  applyAgentHandleStoreCommand,
  confirmAgentStarted,
  rejectAgentEffect,
} from "#subagents/handles/transitions.js";
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
const identity = { id: "agent", name: "research", nodeId: "node", futureIdentity: true };
const address = {
  kind: "agent/local" as const,
  sessionId: "child",
  continuationToken: "child-token",
  futureAddress: true,
};
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

  it("preserves handle/store extensions while retiring owner lease fields", () => {
    const initial = {
      futureStore: true,
      handles: [
        {
          address,
          identity,
          phase: "available" as const,
          futureHandle: true,
        },
      ],
    };
    const loaded = getAgentHandleStore({ "eve.agent.handles": restored(initial) })!;
    const claimed = applyAgentHandleStoreCommand(loaded, {
      kind: "claim",
      agentId: "agent",
      expectedTarget: "local",
      invokedName: "research",
      operationId: "operation",
      ownerId: "owner",
      callId: "call",
    });
    expect(claimed.store).toMatchObject({
      futureStore: true,
      handles: [{ futureHandle: true, phase: "claimed", ownerId: "owner" }],
    });
    const released = applyAgentHandleStoreCommand(claimed.store, {
      kind: "release-owner",
      ownerId: "owner",
    });
    expect(restored(released.store)).toEqual(initial);
    expect(
      getAgentHandleStore(setAgentHandleStore({ "eve.agent.handles": initial }, { handles: [] })),
    ).toEqual({ futureStore: true, handles: [] });
    expect(parseAgentHandleStoreCommand({ kind: "read", futureOption: true })).toBeUndefined();
  });

  it("preserves metadata when a turn-owned handle changes phases", () => {
    const state = {
      "eve.agent.handles": {
        futureStore: true,
        handles: [
          {
            phase: "starting",
            identity,
            futureHandle: true,
            operation: {
              kind: "start",
              id: "operation",
              callId: "call",
              parentTurnId: "turn",
              futureOperation: true,
            },
            target: { kind: "agent/local", continuationToken: "child-token" },
          },
        ],
      },
    };
    const running = confirmAgentStarted(session(state), { operationId: "operation", address });
    const handle = getAgentHandleStore(running.state)!.handles[0]!;
    expect(handle).toMatchObject({ futureHandle: true, operation: { futureOperation: true } });
    expect(handle).not.toHaveProperty("target");
    const continuing = {
      ...handle,
      operation: {
        kind: "continue" as const,
        id: "operation",
        callId: "call",
        parentTurnId: "turn",
        previousStatus: "waiting",
      },
    };
    const parked = rejectAgentEffect(
      session({ "eve.agent.handles": { futureStore: true, handles: [continuing] } }),
      { operationId: "operation", disposition: "retryable" },
    );
    expect(getAgentHandleStore(parked.state)).toMatchObject({
      futureStore: true,
      handles: [{ futureHandle: true, address, identity, phase: "parked" }],
    });
    expect(getAgentHandleStore(parked.state)!.handles[0]).not.toHaveProperty("operation");
  });

  it.each(["ownerId", "operationId", "operation", "callId", "target"])(
    "rejects retired %s on an available handle",
    (key) => {
      expect(() =>
        getAgentHandleStore({
          "eve.agent.handles": {
            handles: [{ phase: "available", address, identity, [key]: "stale" }],
          },
        }),
      ).toThrow("Corrupt agent handle store");
    },
  );
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
