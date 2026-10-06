import { describe, expect, it } from "vitest";

import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { SESSION_CHECKPOINT_VERSION } from "#execution/session/handoff.js";

describe("migrateSessionCheckpoint", () => {
  it("upgrades a checkpoint written by an eve 0.66 owner to the current shape", () => {
    expect(migrateSessionCheckpoint(eve066Checkpoint())).toEqual({
      kind: "current",
      childRunIdsToStop: ["child-local"],
      checkpoint: {
        history: [
          { content: "Alice asks for a report.", kind: "user", role: "user" },
          { content: [{ text: "Started the report.", type: "text" }], role: "assistant" },
          { content: "The report is ready.", kind: "task.result", role: "user" },
        ],
        serializedContext: {
          "eve.auth": null,
          "eve.bundle": { source: { kind: "bundled" } },
          "eve.channel": { kind: "http", state: {} },
          "eve.legacyRemoteAgentCaller": { taskId: "caller-task" },
          "eve.sessionCallback": CALLBACK,
          "eve.sessionTitle": "Alice asks for a report.",
        },
        sessionState: {
          continuationToken: "",
          hasProxyInputRequests: false,
          sessionId: "session-1",
          snapshot: {
            session: {
              agent: { system: "Be helpful." },
              continuationToken: "",
              sandboxState: { session: null },
              sessionId: "session-1",
              state: {
                "eve.harness.requestEnvelopeTokens": 2483.5,
                "eve.harness.sessionProjection": {
                  started: true,
                  nextSequence: 1,
                  turns: {},
                  inputs: {},
                  calls: {},
                  tasks: {},
                  authorizations: {},
                  candidates: {},
                },
              },
            },
          },
          version: 2,
        },
        sessionTimeoutMs: false,
        version: SESSION_CHECKPOINT_VERSION,
      },
    });
  });

  it.each([
    [
      "a version 3 workflow tool run is unsettled",
      { settledTask: false },
      "workflow tool run registry version 3 holds unsettled runs",
    ],
    [
      "a subagent session is working",
      { subagentPhase: "running" },
      "a subagent session is still working",
    ],
  ])("keeps the session on its owner while %s", (_name, options, detail) => {
    expect(migrateSessionCheckpoint(eve066Checkpoint(options))).toEqual({
      kind: "incompatible",
      detail: `checkpoint version 8: ${detail}`,
    });
  });

  it("upgrades an idle v11 checkpoint without losing position, grants, or application state", () => {
    const result = migrateSessionCheckpoint(
      v11Checkpoint({
        "app.counter": 4,
        "eve.harness.emission": { sessionStarted: true, sequence: 3, stepIndex: 0, turnId: "" },
        "eve.runtime.hitl.approvedTools": ["deploy:api"],
      }),
    );
    expect(result).toMatchObject({
      kind: "current",
      checkpoint: {
        version: SESSION_CHECKPOINT_VERSION,
        history: [{ role: "user", kind: "user", content: "Alice asks for a report." }],
        sessionState: {
          version: 2,
          snapshot: {
            session: {
              state: {
                "app.counter": 4,
                "eve.harness.sessionProjection": {
                  started: true,
                  nextSequence: 3,
                  turns: {},
                  inputs: {},
                  calls: {},
                  tasks: {},
                  authorizations: {},
                  candidates: {},
                },
                "eve.harness.turnState": { grants: ["deploy:api"], suspended: [] },
              },
            },
          },
        },
      },
    });
    if (result.kind !== "current") throw new Error(result.detail);
    expect(result.checkpoint.sessionState).not.toHaveProperty("emissionState");
    expect(result.checkpoint.sessionState.snapshot.session.state).not.toHaveProperty(
      "eve.harness.emission",
    );
    expect(result.checkpoint.sessionState.snapshot.session.state).not.toHaveProperty(
      "eve.runtime.hitl.approvedTools",
    );
  });

  it.each([
    { "eve.runtime.pendingInputBatches": [{ requests: [] }] },
    { "eve.runtime.pendingAuthorization": { challenges: [{}] } },
    { "eve.runtime.pendingCoordinationBatch": { tasks: [] } },
    { "eve.runtime.deferredStepInput": { message: "Bob asks for a follow-up." } },
    { "eve.runtime.proxyInputRequests": { child: {} } },
    {
      "eve.harness.emission": { sessionStarted: true, sequence: 1, stepIndex: 0, turnId: "turn_1" },
    },
    { "eve.runtime.pendingInputBatches": "malformed" },
    { "eve.runtime.hitl.approvedTools": [7] },
    { "eve.runtime.hitl.approvalState": { activeCandidates: { alice: {} } } },
    {
      "eve.workflowTool": {
        version: 4,
        runs: [
          {
            callId: "call",
            toolName: "report",
            origin: { turnId: "turn_0", stepIndex: 0 },
            address: { runId: "run", hookToken: "hook" },
          },
        ],
      },
    },
  ])(
    "refuses v11 pending or malformed state without changing the owner's checkpoint (%j)",
    (state) => {
      const checkpoint = v11Checkpoint(state);
      const before = structuredClone(checkpoint);
      expect(migrateSessionCheckpoint(checkpoint)).toMatchObject({ kind: "incompatible" });
      expect(checkpoint).toEqual(before);
    },
  );

  it.each([7, SESSION_CHECKPOINT_VERSION + 1])("refuses checkpoint version %s", (version) => {
    expect(migrateSessionCheckpoint({ ...eve066Checkpoint(), version })).toMatchObject({
      kind: "incompatible",
    });
  });
});

function v11Checkpoint(state: Record<string, unknown>) {
  return {
    version: 11,
    serializedContext: {},
    history: [{ role: "user", kind: "user", content: "Alice asks for a report." }],
    sessionTimeoutMs: false,
    sessionState: {
      version: 2,
      sessionId: "session-1",
      continuationToken: "token",
      hasProxyInputRequests: false,
      emissionState: { sessionStarted: true, sequence: 3, stepIndex: 0, turnId: "" },
      snapshot: { session: { sessionId: "session-1", continuationToken: "token", state } },
    },
  };
}

const CALLBACK = {
  callId: "call-0",
  subagentName: "research",
  token: "callback-token",
  url: "https://caller.example/eve/v1/callback/callback-token",
};

/** Trimmed from a handoff checkpoint captured from an eve 0.66.1 owner. */
function eve066Checkpoint({
  settledTask = true,
  subagentPhase = "parked",
}: { readonly settledTask?: boolean; readonly subagentPhase?: string } = {}) {
  return {
    mode: "conversation",
    serializedContext: {
      "eve.auth": null,
      "eve.bundle": { source: { kind: "bundled" } },
      "eve.channel": { kind: "http", state: {} },
      "eve.mode": "conversation",
      "eve.runtime.taskDeliveryPolicy": "auto",
      "eve.sessionCallback": { ...CALLBACK, taskId: "caller-task" },
      "eve.sessionTitle": "Alice asks for a report.",
      "eve.turnTaskDelivery": "none",
    },
    sessionState: {
      continuationToken: "",
      emissionState: { sessionStarted: true, sequence: 1, stepIndex: 0, turnId: "" },
      hasProxyInputRequests: false,
      sessionId: "session-1",
      snapshot: {
        session: {
          agent: { system: "Be helpful." },
          continuationToken: "",
          history: [
            { content: "Alice asks for a report.", kind: "user", role: "user" },
            { content: [{ text: "Started the report.", type: "text" }], role: "assistant" },
            { content: "The report is ready.", kind: "execution.background_task", role: "user" },
          ],
          sandboxState: { session: null },
          sessionId: "session-1",
          state: {
            "eve.agent.handles": {
              handles: [
                {
                  address: {
                    continuationToken: "local-token",
                    kind: "agent/local",
                    sessionId: "child-local",
                  },
                  phase: subagentPhase,
                },
                {
                  address: {
                    kind: "agent/remote",
                    sessionId: "child-remote",
                    url: "https://remote.example",
                  },
                  phase: "available",
                },
              ],
            },
            "eve.harness.requestEnvelopeTokens": 2483.5,
            "eve.workflowTool": {
              runs: [
                {
                  address: { hookToken: "hook-1", runId: "run-1" },
                  callId: "call-1",
                  lifetime: "session",
                  origin: { stepIndex: 0, turnId: "turn_0" },
                  task: {
                    dispatchContext: { auth: { current: null, initiator: null } },
                    metadata: { kind: "tool", name: "report" },
                    outcome: settledTask
                      ? { lastOutput: { type: "result", value: "ready" }, status: "completed" }
                      : undefined,
                    taskId: "task-1",
                  },
                  toolName: "report",
                },
              ],
              version: 3,
            },
          },
          taskId: "task-0",
        },
      },
      version: 1,
    },
    sessionTimeoutMs: false,
    version: 8,
  };
}
