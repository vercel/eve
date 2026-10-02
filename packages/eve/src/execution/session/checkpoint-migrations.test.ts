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
          emissionState: { sessionStarted: true, sequence: 1, stepIndex: 0, turnId: "" },
          hasProxyInputRequests: false,
          sessionId: "session-1",
          snapshot: {
            session: {
              agent: { system: "Be helpful." },
              continuationToken: "",
              sandboxState: { session: null },
              sessionId: "session-1",
              state: { "eve.harness.requestEnvelopeTokens": 2483.5 },
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

  it.each([7, SESSION_CHECKPOINT_VERSION + 1])("refuses checkpoint version %s", (version) => {
    expect(migrateSessionCheckpoint({ ...eve066Checkpoint(), version })).toMatchObject({
      kind: "incompatible",
    });
  });
});

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
