import { assert, describe, expect, it } from "vitest";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { isSessionStateIdleForHandoff } from "#execution/session/handoff-steps.js";
import {
  readWorkflowTaskView,
  recordWorkflowTaskView,
  getBackgroundTasks,
  registerWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { parseActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { HarnessSession } from "#harness/types.js";
import type { AgentHandle, AgentHandlePhase } from "#subagents/handles/store.js";

const metadata = { kind: "tool", name: "research" };
const activity = {
  id: "work",
  kind: "task" as const,
  rootSessionId: "root",
  rootTurnId: "turn",
  futureActivity: { label: "Alice's research" },
};
const task = {
  callId: "task",
  toolName: metadata.name,
  lifetime: "session" as const,
  origin: { turnId: "turn", stepIndex: 0, futureOrigin: true },
  address: { runId: "run", hookToken: "inbox", futureAddress: true },
  futureInvocation: true,
  task: {
    taskId: "task",
    metadata,
    activityWorkIdentity: activity,
    futureTask: { revision: 2 },
    outcome: {
      status: "completed" as const,
      lastOutput: { type: "result" as const, data: "done", futureOutput: true },
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        futureUsage: true,
      },
      futureView: true,
    },
    dispatchContext: { auth: { current: null, initiator: null } },
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

const identity = { id: "ag_researcher:operation", name: "researcher", nodeId: "agent" };
const address = {
  continuationToken: "subagent:parent:call",
  kind: "agent/local" as const,
  sessionId: "child-session",
};
const startOperation = {
  callId: "call",
  id: "operation",
  kind: "start" as const,
  parentTurnId: "turn",
};

function handle(phase: AgentHandlePhase): AgentHandle {
  switch (phase) {
    case "starting":
      return {
        identity,
        operation: startOperation,
        phase,
        target: { continuationToken: address.continuationToken, kind: "agent/local" },
      };
    case "running":
      return { address, identity, operation: startOperation, phase };
    case "parked":
      return { address, identity, lastStatus: "Research complete", phase };
    case "reserved":
      return { identity, operationId: "operation", ownerId: "task", phase };
    case "claimed":
      return { address, identity, operationId: "operation", ownerId: "task", phase };
    case "available":
      return { address, identity, phase };
  }
}

describe("additive durable state", () => {
  it("preserves task extensions through parsing, replayed creation and duplicate terminal deliveries", () => {
    const state = {
      authored: { opaque: true },
      "eve.workflowTool": { version: 3, runs: [task], futureIndex: true },
    };
    expect(
      getBackgroundTasks(restored(state))
        .query()
        .map((entry) => entry.run),
    ).toEqual([task]);
    expect(parseActivityWorkIdentityV1(activity)).toEqual(activity);
    const updated = registerWorkflowToolRun(session(restored(state)), {
      callId: "task",
      toolName: metadata.name,
      lifetime: "session" as const,
      origin: { turnId: "turn", stepIndex: 0 },
      address: { runId: "new-run", hookToken: "inbox" },
      task: {
        taskId: "task",
        dispatchContext: { auth: { current: null, initiator: null } },
        metadata,
        activityWorkIdentity: {
          id: "work",
          kind: "task",
          rootSessionId: "root",
          rootTurnId: "turn",
        },
      },
    });
    const saved = recordWorkflowTaskView(updated.state, {
      taskId: "task",
      metadata,
      status: "completed",
      lastOutput: { type: "result", data: "updated" },
      usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }).state;
    expect(restored(saved)).toMatchObject({
      authored: { opaque: true },
      "eve.workflowTool": {
        version: 3,
        futureIndex: true,
        runs: [
          {
            address: { runId: "new-run", futureAddress: true },
            origin: { futureOrigin: true },
            futureInvocation: true,
            task: {
              futureTask: { revision: 2 },
              activityWorkIdentity: activity,
              outcome: {
                futureView: true,
                lastOutput: { data: "done", futureOutput: true },
                usage: { inputTokens: 1, futureUsage: true },
              },
            },
          },
        ],
      },
    });
    assert(saved !== undefined);
    expect(isSessionStateIdleForHandoff(checkpoint(restored(saved)))).toBe(true);
    const cancelled = recordWorkflowTaskView(saved, {
      taskId: "task",
      metadata,
      status: "cancelled",
    }).state;
    expect(getBackgroundTasks(restored(cancelled)).get("task")?.run.task.outcome).toMatchObject({
      futureView: true,
      status: "completed",
    });
    expect(cancelled).toBe(saved);
    const retained = getBackgroundTasks(restored(cancelled)).get("task");
    assert(retained !== undefined);
    expect(readWorkflowTaskView(retained.run.task)?.lastOutput?.data).toBe("done");
  });
});

describe("handoff state inspection", () => {
  it("accepts additive framework metadata and opaque authored state", () => {
    expect(
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.agent.handles": { handles: [], futureStore: true },
          authored: { version: "anything", values: [null, false] },
          "eve.workflowTool": { version: 3, runs: [task], futureIndex: true },
        }),
      ),
    ).toBe(true);
  });
  it.each(["parked", "available"] as const)(
    "allows an idle %s agent handle to cross a handoff",
    (phase) => {
      expect(
        isSessionStateIdleForHandoff(
          checkpoint({ "eve.agent.handles": { handles: [handle(phase)] } }),
        ),
      ).toBe(true);
    },
  );
  it.each(["starting", "running", "reserved", "claimed"] as const)(
    "refuses an active %s agent handle",
    (phase) => {
      expect(
        isSessionStateIdleForHandoff(
          checkpoint({ "eve.agent.handles": { handles: [handle(phase)] } }),
        ),
      ).toBe(false);
    },
  );
  it("parses idle handles before accepting them", () => {
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.agent.handles": {
            handles: [{ ...handle("parked"), address: { ...address, sessionId: "" } }],
          },
        }),
      ),
    ).toThrow("Corrupt agent handle store");
  });
  it("parses settled entries before checking their terminal status", () => {
    const incompatible = { ...task, address: { ...task.address, hookToken: 42 } };
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.workflowTool": { version: 3, runs: [incompatible] },
        }),
      ),
    ).toThrow("Corrupt workflow tool run registry");
  });
  it("does not skip task parsing when another registry is busy", () => {
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.runtime.pendingAuthorization": {},
          "eve.workflowTool": {
            version: 3,
            runs: [{ ...task, address: { ...task.address, runId: null } }],
          },
        }),
      ),
    ).toThrow("Corrupt workflow tool run registry");
  });
  it("validates retained results even when other work prevents handoff", () => {
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.runtime.pendingAuthorization": {},
          "eve.workflowTool": {
            version: 3,
            runs: [{ ...task, task: { ...task.task, outcome: { status: "completed" } } }],
          },
        }),
      ),
    ).toThrow("Corrupt workflow task result");
  });
  it.each([
    ["eve.runtime.pendingAuthorization", false],
    ["eve.runtime.pendingInputBatch", {}],
    ["eve.runtime.pendingInputBatches", [null]],
    ["eve.runtime.pendingCoordinationBatch", {}],
    ["eve.runtime.deferredStepInput", {}],
    ["eve.harness.pendingWorkflowInterrupt", {}],
    ["eve.runtime.proxyInputRequests", { malformed: null }],
  ])("refuses nonempty or unreadable pending work in %s", (key, value) => {
    expect(isSessionStateIdleForHandoff(checkpoint({ [key]: value }))).toBe(false);
  });
});
