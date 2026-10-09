import { describe, expect, it } from "vitest";

import { readDurableSession } from "#execution/durable-session-store.js";
import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { SESSION_CHECKPOINT_VERSION } from "#execution/session/handoff.js";
import { createApprovalCandidate, getApprovalAuditState } from "#harness/hitl/candidates.js";
import { readHitlState } from "#harness/hitl/requests.js";
import { readTurnState } from "#harness/session-machine/state.js";

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

  it("moves a v13 checkpoint's task table and waiting runs into one record of running work", () => {
    const run = {
      callId: "call",
      toolName: "report",
      origin: { turnId: "turn_0", stepIndex: 0 },
      address: { runId: "run", hookToken: "hook" },
    };
    const task = { taskId: "task_1", status: "working" };
    const result = migrateSessionCheckpoint(
      v13Checkpoint({
        "app.counter": 4,
        "eve.taskTable": { version: 1, tasks: [task] },
        "eve.workflowTool": { version: 4, runs: [run] },
      }),
    );
    if (result.kind !== "current") throw new Error(result.detail);
    expect(result.checkpoint.sessionState.snapshot.session.state).toEqual({
      "app.counter": 4,
      "eve.work": { version: 1, calls: [run], tasks: [task] },
    });
  });

  it("drops a v13 checkpoint's empty stores of running work", () => {
    const result = migrateSessionCheckpoint(
      v13Checkpoint({
        "app.counter": 4,
        "eve.taskTable": { version: 1, tasks: [] },
        "eve.workflowTool": { version: 4, runs: [] },
      }),
    );
    if (result.kind !== "current") throw new Error(result.detail);
    expect(result.checkpoint.sessionState.snapshot.session.state).toEqual({ "app.counter": 4 });
  });

  it.each([
    [{ "eve.taskTable": { version: 2, tasks: [] } }, "task table is malformed"],
    [
      { "eve.workflowTool": { version: 3, runs: [] } },
      "workflow tool run registry is incompatible",
    ],
    [
      { "eve.taskTable": { version: 1, tasks: [] }, "eve.work": { version: 1 } },
      "v13 checkpoint already holds the running-work record",
    ],
  ])("refuses v13 running work it cannot move (%j)", (state, detail) => {
    expect(migrateSessionCheckpoint(v13Checkpoint(state))).toEqual({
      kind: "incompatible",
      detail: `checkpoint version 13: ${detail}`,
    });
  });

  it.each([7, SESSION_CHECKPOINT_VERSION + 1])("refuses checkpoint version %s", (version) => {
    expect(migrateSessionCheckpoint({ ...eve066Checkpoint(), version })).toMatchObject({
      kind: "incompatible",
    });
  });

  it.each([12, 13])(
    "loads a saved version %s session's approvals, sign-ins and relays from the requests key",
    (version) => {
      const alice = { authenticator: "slack", principalId: "alice", principalType: "user" };
      const bob = { ...alice, principalId: "bob" };
      const settlement = {
        actor: alice,
        approver: { ...alice, attributes: {} },
        candidateId: "alice",
        outcome: "allowed",
        requestId: "deploy",
        settledAt: 300,
      };
      const candidateSignIn = {
        attemptId: "attempt-bob",
        candidateId: "bob",
        challenge: { instructions: "Sign in to GitHub." },
        hookUrl: "https://app.example/cb/bob",
        name: "github",
      };
      const bobCandidate = {
        authorizationChallenges: [candidateSignIn],
        candidateId: "bob",
        createdAt: 400,
        decision: "cancel",
        expiresAt: 900,
        requestId: "release",
        responder: { ...bob, attributes: { team: "infra" } },
        status: "authorization-required",
      };
      const signIn = {
        attemptId: "attempt-1",
        challenge: { instructions: "Sign in to Linear." },
        hookUrl: "https://app.example/cb/1",
        name: "linear",
        principal: { id: "alice", type: "user" },
      };
      const event = { sequence: 4, stepIndex: 0, turnId: "turn_1" };
      const relayed = {
        batch: { approvalRequestIds: ["child-approval"], requestIds: ["child-approval"] },
        childContinuationToken: "child-token",
        childSessionInbox: { sessionId: "child-session" },
        event,
        inputSource: "subagent:research",
        kind: "tool-approval",
        reply: { options: [{ id: "approve", label: "Approve" }] },
      };
      const asked = {
        childContinuationToken: "run-token",
        event,
        kind: "question",
        reply: { allowFreeform: true },
        runId: "run-1",
        workflowAsk: { control: "control-hook" },
      };
      const relays = {
        "child-approval": relayed,
        "run-question": asked,
        // A child request id shaped like a sign-in attempt stays a relay.
        "signin:attempt-1": { ...asked, runId: "run-2" },
      };
      const saved = JSON.stringify(
        savedCheckpoint(version, {
          "eve.harness.turnState": { grants: ["deploy:api"], suspended: [] },
          "eve.runtime.hitl.approvalState": {
            activeCandidates: { bob: bobCandidate },
            candidateHistory: [
              {
                candidateId: "alice",
                completedAt: 300,
                createdAt: 200,
                decision: "approve",
                requestId: "deploy",
                responder: alice,
                status: "allowed",
              },
            ],
            nextCandidateSequence: 2,
            settlements: { deploy: settlement },
          },
          "eve.runtime.pendingAuthorization": { challenges: [signIn] },
          "eve.runtime.proxyInputRequests": relays,
          "eve.unrelated": true,
        }),
      );

      const result = migrateSessionCheckpoint(JSON.parse(saved));
      if (result.kind !== "current") throw new Error(result.detail);
      const reloaded = JSON.parse(JSON.stringify(result.checkpoint));
      const { state } = readDurableSession(reloaded.sessionState);
      expect(Object.keys(state ?? {}).sort()).toEqual([
        "eve.harness.turnState",
        "eve.runtime.hitl.requests",
        "eve.unrelated",
      ]);
      const hitl = readHitlState(state);
      expect(readTurnState(state).grants).toEqual(["deploy:api"]);
      expect(hitl.signIns).toEqual([signIn]);
      expect(Object.fromEntries(hitl.relays)).toEqual(relays);
      const audit = getApprovalAuditState(state);
      expect(audit.activeCandidates).toEqual([bobCandidate]);
      expect(audit.candidateHistory.map((entry) => entry.candidateId)).toEqual(["alice"]);
      expect(audit.settlements).toEqual([settlement]);
      // Ids already issued stay taken: a responder reusing one gets a fresh one.
      const next = createApprovalCandidate({
        candidateIdPrefix: "alice",
        createdAt: 500,
        decision: "approve",
        expiresAt: 900,
        requestId: "release",
        responder: { ...alice, attributes: {} },
        state,
      });
      expect(getApprovalAuditState(next.state).activeCandidates.map((c) => c.candidateId)).toEqual([
        "bob",
        "alice.2",
      ]);
      // A current checkpoint loads unchanged.
      expect(migrateSessionCheckpoint(reloaded)).toEqual({ ...result, checkpoint: reloaded });
    },
  );
});

function savedCheckpoint(version: number, state: Record<string, unknown>) {
  return { ...v11Checkpoint(state), version };
}

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

function v13Checkpoint(state: Record<string, unknown>) {
  return {
    version: 13,
    serializedContext: {},
    history: [{ role: "user", kind: "user", content: "Alice asks for a report." }],
    sessionTimeoutMs: false,
    sessionState: {
      version: 2,
      sessionId: "session-1",
      continuationToken: "token",
      hasProxyInputRequests: false,
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
