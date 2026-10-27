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
        checkpoint: {
          admittedDeliveryKeys: [],
          // The caller speaks protocol 1, so the session relays it no requests.
          capabilities: { requestInput: false },
          history: [
            { content: "Alice asks for a report.", kind: "user", role: "user" },
            { content: [{ text: "Started the report.", type: "text" }], role: "assistant" },
            { content: "The report is ready.", kind: "user", role: "user" },
          ],
          serializedContext: {
            ...eve066Checkpoint().serializedContext,
            "eve.capabilities": { requestInput: false },
            "eve.earlierRemoteCaller": 1,
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
                state: {},
              },
            },
            version: 2,
          },
          sessionTimeoutMs: false,
          version: SESSION_CHECKPOINT_VERSION,
        },
        turnCount: 1,
      },
    });
  });

  it("keeps an eve 0.83 session's identity and authored state, not its framework records", () => {
    const result = migrateSessionCheckpoint(
      eve083Checkpoint(
        {
          "app.counter": 4,
          "eve.harness.turnState": { grants: ["deploy:api"], suspended: [] },
          "eve:mount.v1:notes:draft": "Bob's notes",
        },
        { "eve.sessionCallback": CALLBACK },
      ),
    );
    if (result.kind !== "pre-v27") throw new Error(JSON.stringify(result));
    const { checkpoint, turnCount } = result.imported;
    expect(turnCount).toBe(3);
    expect(checkpoint.admittedDeliveryKeys).toEqual(["delivery-3"]);
    expect(checkpoint.sessionState.snapshot.session.state).toEqual({
      "app.counter": 4,
      "eve:mount.v1:notes:draft": "Bob's notes",
    });
    expect(checkpoint.serializedContext).toMatchObject({
      "eve.earlierRemoteCaller": 2,
      "eve.sessionCallback": CALLBACK,
    });
  });

  it.each([
    ["a turn is still open", { [PROJECTION]: { activeTurnId: "turn_2", nextSequence: 3 } }],
    ["its turn position is malformed", { [PROJECTION]: { nextSequence: -1 } }],
    [
      "a task still runs",
      {
        "eve.taskTable": {
          tasks: [{ calls: [], id: "t", results: [], run: { hookToken: "h", runId: "r" } }],
          version: 1,
        },
      },
    ],
  ])("keeps the session on its owner while %s", (_name, state) => {
    const saved = eve083Checkpoint(state);
    const before = structuredClone(saved);
    expect(migrateSessionCheckpoint(saved)).toMatchObject({ kind: "incompatible" });
    expect(saved).toEqual(before);
  });

  it("keeps an eve 0.66 session that keeps subagent sessions on its owner", () => {
    expect(migrateSessionCheckpoint(eve066Checkpoint({ subagents: true }))).toEqual({
      detail: "checkpoint version 8: session keeps subagent sessions",
      kind: "incompatible",
    });
  });
});

const PROJECTION = "eve.harness.sessionProjection";

const CALLBACK = {
  callId: "call-0",
  subagentName: "research",
  token: "callback-token",
  url: "https://caller.example/eve/v1/callback/callback-token",
};

/** An idle session an eve 0.83 owner hands off after its third turn. */
function eve083Checkpoint(state: Record<string, unknown>, context: Record<string, unknown> = {}) {
  return {
    admittedDeliveryKeys: ["delivery-3"],
    history: [{ content: "Alice asks for the weekly report.", kind: "user", role: "user" }],
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
function eve066Checkpoint({ subagents = false }: { readonly subagents?: boolean } = {}) {
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
            ...(subagents && {
              "eve.agent.handles": {
                handles: [
                  {
                    address: {
                      continuationToken: "local-token",
                      kind: "agent/local",
                      sessionId: "child-local",
                    },
                    phase: "parked",
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
            }),
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
                    outcome: {
                      lastOutput: { type: "result", value: "ready" },
                      status: "completed",
                    },
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
