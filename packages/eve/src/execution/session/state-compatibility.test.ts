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
  resultKind: "tool" as const,
  lifetime: "session" as const,
  origin: { turnId: "turn", stepIndex: 0 },
  address: { runId: "run", hookToken: "inbox" },
  task: {
    taskId: "task",
    metadata,
    activityWorkIdentity: activity,
    futureTask: { revision: 2 },
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
  it("preserves task extensions through parsing, replayed creation and terminal updates", () => {
    const state = {
      authored: { opaque: true },
      "eve.runtime.workflowInvocations": { version: 1, invocations: [task], futureIndex: true },
    };
    expect(getSessionTaskIndex(restored(state))).toEqual([task]);
    expect(parseActivityWorkIdentityV1(activity)).toEqual(activity);
    const updated = recordSessionTask(session(restored(state)), {
      callId: "task",
      toolName: metadata.name,
      resultKind: "tool" as const,
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
    const saved = cacheTerminalTaskView(updated.state, {
      taskId: "task",
      metadata,
      status: "completed",
      lastOutput: { type: "result", data: "updated" },
      usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(restored(saved)).toMatchObject({
      authored: { opaque: true },
      "eve.runtime.workflowInvocations": {
        version: 1,
        futureIndex: true,
        invocations: [
          {
            address: { runId: "new-run" },
            task: {
              futureTask: { revision: 2 },
              activityWorkIdentity: activity,
              terminalView: {
                futureView: true,
                lastOutput: { data: "updated", futureOutput: true },
                usage: { inputTokens: 3, futureUsage: true },
              },
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
    expect(getSessionTaskIndex(restored(cancelled))[0]?.task.terminalView).toMatchObject({
      futureView: true,
      status: "cancelled",
    });
    expect(
      getSessionTaskIndex(restored(cancelled))[0]?.task.terminalView?.lastOutput,
    ).toBeUndefined();
  });
});

describe("handoff state inspection", () => {
  it("accepts additive framework metadata and opaque authored state", () => {
    expect(
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.agent.handles": { handles: [], futureStore: true },
          authored: { version: "anything", values: [null, false] },
          "eve.runtime.workflowInvocations": { version: 1, invocations: [task], futureIndex: true },
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
          "eve.runtime.workflowInvocations": { version: 1, invocations: [incompatible] },
        }),
      ),
    ).toThrow("Corrupt workflow invocation registry");
  });
  it("does not skip task parsing when another registry is busy", () => {
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.runtime.pendingAuthorization": {},
          "eve.runtime.workflowInvocations": {
            version: 1,
            invocations: [{ ...task, address: { ...task.address, runId: null } }],
          },
        }),
      ),
    ).toThrow("Corrupt workflow invocation registry");
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
