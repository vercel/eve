import { describe, expect, it } from "vitest";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { isSessionStateIdleForHandoff } from "#execution/session/handoff-steps.js";
import type { AgentHandle, AgentHandlePhase } from "#subagents/handles/store.js";

const run = {
  callId: "call",
  toolName: "research",
  origin: { turnId: "turn", stepIndex: 0 },
  address: { runId: "run", hookToken: "inbox" },
};

function checkpoint(state: Record<string, unknown>) {
  const value = createTestSessionState();
  return { ...value, snapshot: { session: { ...value.snapshot.session, state } } };
}

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
      return { identity, operationId: "operation", ownerId: "run", phase };
    case "claimed":
      return { address, identity, operationId: "operation", ownerId: "run", phase };
    case "available":
      return { address, identity, phase };
  }
}

describe("handoff state inspection", () => {
  it("accepts additive framework metadata and opaque authored state", () => {
    expect(
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.agent.handles": { handles: [], futureStore: true },
          authored: { version: "anything", values: [null, false] },
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
  it("parses workflow tool runs before checking for waiting work", () => {
    const incompatible = { ...run, address: { ...run.address, hookToken: 42 } };
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.workflowTool": { version: 4, runs: [incompatible] },
        }),
      ),
    ).toThrow("Corrupt workflow tool run registry");
  });
  it("does not skip run parsing when another registry is busy", () => {
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.runtime.pendingAuthorization": {},
          "eve.workflowTool": {
            version: 4,
            runs: [{ ...run, address: { ...run.address, runId: null } }],
          },
        }),
      ),
    ).toThrow("Corrupt workflow tool run registry");
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
