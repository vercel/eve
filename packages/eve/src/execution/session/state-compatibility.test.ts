import { describe, expect, it } from "vitest";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { isSessionStateIdleForHandoff } from "#execution/session/handoff-steps.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";

const turnRun = {
  callId: "call",
  toolName: "research",
  lifetime: "turn" as const,
  origin: { turnId: "turn", stepIndex: 0 },
  address: { runId: "run", hookToken: "inbox" },
};
const backgroundRun = {
  ...turnRun,
  lifetime: "session" as const,
  task: {
    taskId: "call",
    metadata: { kind: "tool", name: "research" },
    dispatchContext: { auth: { current: null, initiator: null } },
  },
};
const child = {
  continuationToken: "subagent:parent:call",
  kind: "local" as const,
  sessionId: "child-session",
};
function checkpoint(state: Record<string, unknown>) {
  const value = createTestSessionState();
  return { ...value, snapshot: { session: { ...value.snapshot.session, state } } };
}
describe("handoff state inspection", () => {
  it("accepts additive framework metadata and opaque authored state", () => {
    expect(
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.taskTable": { records: [], futureIndex: true },
          authored: { version: "anything", values: [null, false] },
          "eve.workflowTool": { version: 3, runs: [], futureIndex: true },
        }),
      ),
    ).toBe(true);
  });
  it("refuses a waiting turn-owned workflow tool run", () => {
    expect(
      isSessionStateIdleForHandoff(
        checkpoint({ "eve.workflowTool": { version: 3, runs: [turnRun] } }),
      ),
    ).toBe(false);
  });
  it("ignores runs recorded by releases with background workflow tools", () => {
    expect(
      isSessionStateIdleForHandoff(
        checkpoint({ "eve.workflowTool": { version: 3, runs: [backgroundRun] } }),
      ),
    ).toBe(true);
  });
  it.each(["completed", "failed", "cancelled"] as const)(
    "allows an idle agent whose last task %s to cross a handoff",
    (status) => {
      expect(
        isSessionStateIdleForHandoff(
          checkpoint(taskTableState([createTaskRecord({ child, delivered: true, status })])),
        ),
      ).toBe(true);
    },
  );
  it.each(["working", "input_required"] as const)("refuses a %s agent task", (status) => {
    expect(
      isSessionStateIdleForHandoff(checkpoint(taskTableState([createTaskRecord({ status })]))),
    ).toBe(false);
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
