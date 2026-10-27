import { describe, expect, it } from "vitest";

import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { SESSION_CHECKPOINT_VERSION } from "#execution/session/handoff.js";

function checkpoint(version: number) {
  return {
    admittedDeliveryKeys: [],
    history: [],
    serializedContext: {},
    sessionState: { sessionId: "session-1", version: 2 },
    version,
  };
}

describe("migrateSessionCheckpoint", () => {
  it("accepts a current checkpoint unchanged", () => {
    expect(migrateSessionCheckpoint(checkpoint(SESSION_CHECKPOINT_VERSION))).toEqual({
      checkpoint: checkpoint(SESSION_CHECKPOINT_VERSION),
      kind: "current",
    });
  });

  it.each([
    undefined,
    ["alice", 1],
    [""],
    ["x".repeat(257)],
    Array.from({ length: 1025 }, (_, index) => `delivery-${index}`),
  ])(
    "refuses a current checkpoint with an invalid delivery-key window (%#)",
    (admittedDeliveryKeys) => {
      expect(
        migrateSessionCheckpoint({
          ...checkpoint(SESSION_CHECKPOINT_VERSION),
          admittedDeliveryKeys,
        }),
      ).toMatchObject({ kind: "incompatible" });
    },
  );

  it.each([7, SESSION_CHECKPOINT_VERSION + 1])("refuses checkpoint version %s", (version) => {
    expect(migrateSessionCheckpoint({ ...eve066Checkpoint(), version })).toMatchObject({
      kind: "incompatible",
    });
  });
});

describe("migrateSessionCheckpoint from an owner before v27", () => {
  it("imports a checkpoint written by an eve 0.66 owner", () => {
    expect(migrateSessionCheckpoint(eve066Checkpoint())).toEqual({
      kind: "pre-v27",
      imported: {
        childRunIdsToStop: ["child-local"],
        checkpoint: {
          admittedDeliveryKeys: [],
          // The caller speaks protocol 1, so the session relays it no requests.
          capabilities: { requestInput: false },
          history: [
            { content: "Alice asks for a report.", kind: "user", role: "user" },
            { content: [{ text: "Started the report.", type: "text" }], role: "assistant" },
            { content: "The report is ready.", kind: "task.result", role: "user" },
          ],
          serializedContext: {
            "eve.auth": null,
            "eve.bundle": { source: { kind: "bundled" } },
            "eve.channel": { kind: "http", state: {} },
            "eve.earlierRemoteCaller": 1,
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
                compaction: { requestEnvelopeTokens: 2483.5 },
                continuationToken: "",
                sandboxState: { session: null },
                sessionId: "session-1",
                state: {},
              },
            },
            version: 2,
          },
          sessionTimeoutMs: false,
          version: SESSION_CHECKPOINT_VERSION,
        },
        seed: { turnCount: 1 },
      },
    });
  });

  it("reads an eve 0.83 session's usage, budget window, history, and context in v27's shape", () => {
    const result = migrateSessionCheckpoint(
      eve083Checkpoint(
        {
          "app.counter": 4,
          "eve.harness.reportedSessionUsage": { ...SPEND, costUsd: 0.5, sawCost: false },
          "eve.harness.requestEnvelopeTokens": 900,
          "eve.harness.sessionUsageWindowIndex": 2,
          "eve.harness.sessionUsageWindowStart": { ...SPEND, costUsd: 0.25, sawCost: true },
          "eve.harness.turnState": { grants: ["deploy:api"], suspended: [] },
          "eve.harness.turnUsage": { session: { ...SPEND, costUsd: 1.5, sawCost: true } },
          "eve.memory": { locks: {}, operationDigests: [] },
          "eve.runtime.hitl.requests": { approvals: { activeCandidates: {}, settlements: {} } },
          "eve.taskTable": {
            tasks: [{ calls: [], id: "task-1", kind: "tool", name: "report", results: [] }],
            version: 1,
          },
        },
        {
          "eve.dynamicSkillSandbox": { notes: "sandbox-1" },
          "eve.experimental.decide.model.abc": { model: "m", turnId: "turn_2" },
          "eve.runtimeModelMetadataCache": {},
          "eve.sessionCallback": CALLBACK,
          "eve.sessionDynamicInstructions": {},
        },
        [
          { content: "Alice asks for the weekly report.", kind: "user", role: "user" },
          {
            content: "Alice prefers short summaries.",
            kind: "memory.load",
            metadata: { "eve.memory": { slot: "preferences" } },
            role: "user",
          },
          { content: [{ text: "Here is the report.", type: "text" }], role: "assistant" },
        ],
      ),
    );
    if (result.kind !== "pre-v27") throw new Error(JSON.stringify(result));
    const { checkpoint, seed } = result.imported;
    expect(seed).toEqual({
      turnCount: 3,
      usage: { ...SPEND, costUsd: 1.5 },
      usageWindow: { index: 2, start: { ...SPEND, costUsd: 0.25 } },
    });
    expect(checkpoint.sessionState.snapshot.session).toMatchObject({
      compaction: { lastKnownInputTokens: 1200, requestEnvelopeTokens: 900 },
      // Settled registries, retired usage records, grants, and memory locks are gone.
      state: { "app.counter": 4, "eve.harness.reportedSessionUsage": SPEND },
    });
    expect(Object.keys(checkpoint.sessionState.snapshot.session.state ?? {}).sort()).toEqual([
      "app.counter",
      "eve.harness.reportedSessionUsage",
    ]);
    // v27 recalls memory on every call instead of keeping it in history.
    expect(checkpoint.history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(checkpoint.serializedContext).toEqual({
      "eve.bundle": { source: { kind: "bundled" } },
      "eve.dynamicSkillSandbox": { notes: "sandbox-1#" },
      "eve.earlierRemoteCaller": 2,
      "eve.sessionCallback": CALLBACK,
      "eve.stateLayout": 1,
    });
    expect(checkpoint.capabilities).toEqual({ requestInput: false });
  });

  it.each([
    ["a turn is still open", { [PROJECTION]: { activeTurnId: "turn_2", nextSequence: 3 } }],
    ["turn input is queued", { "eve.harness.turnState": { queued: {}, suspended: [] } }],
    ["a step is suspended", { "eve.harness.turnState": { suspended: [{}] } }],
    ["a sign-in is open", { "eve.runtime.hitl.requests": { signIns: [{}] } }],
    ["input is relayed", { "eve.runtime.hitl.requests": { relays: { child: {} } } }],
    [
      "an approval waits",
      { "eve.runtime.hitl.requests": { approvals: { activeCandidates: { bob: {} } } } },
    ],
    [
      "a task runs",
      {
        "eve.taskTable": {
          tasks: [{ calls: [], id: "t", results: [], run: { hookToken: "h", runId: "r" } }],
          version: 1,
        },
      },
    ],
    [
      "a workflow tool runs",
      { "eve.workflowTool": { runs: [{ callId: "call", toolName: "report" }], version: 4 } },
    ],
  ])("keeps the session on its owner while %s", (_name, state) => {
    const saved = eve083Checkpoint(state);
    const before = structuredClone(saved);
    expect(migrateSessionCheckpoint(saved)).toMatchObject({ kind: "incompatible" });
    expect(saved).toEqual(before);
  });

  it.each([
    ["a version 3 workflow tool run is unsettled", { settledTask: false }],
    ["a subagent session is working", { subagentPhase: "running" }],
  ])("keeps an eve 0.66 session on its owner while %s", (_name, options) => {
    expect(migrateSessionCheckpoint(eve066Checkpoint(options))).toMatchObject({
      kind: "incompatible",
    });
  });
});

const PROJECTION = "eve.harness.sessionProjection";
const SPEND = { cacheReadTokens: 10, cacheWriteTokens: 0, inputTokens: 300, outputTokens: 40 };

const CALLBACK = {
  callId: "call-0",
  subagentName: "research",
  token: "callback-token",
  url: "https://caller.example/eve/v1/callback/callback-token",
};

/** An idle session an eve 0.83 owner hands off after its third turn. */
function eve083Checkpoint(
  state: Record<string, unknown>,
  context: Record<string, unknown> = {},
  history: unknown[] = [
    { content: "Alice asks for the weekly report.", kind: "user", role: "user" },
  ],
) {
  return {
    admittedDeliveryKeys: ["delivery-3"],
    history,
    serializedContext: {
      "eve.bundle": { source: { kind: "bundled" } },
      "eve.stateLayout": 1,
      ...context,
    },
    sessionState: {
      continuationToken: "token",
      hasProxyInputRequests: false,
      sessionId: "session-1",
      snapshot: {
        session: {
          compaction: { lastKnownInputTokens: 1200 },
          continuationToken: "token",
          sessionId: "session-1",
          state: {
            [PROJECTION]: { nextSequence: 3, started: true, turns: {} },
            ...state,
          },
        },
      },
      version: 2,
    },
    sessionTimeoutMs: 60_000,
    version: 17,
  };
}

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
