import { describe, expect, it } from "vitest";

import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { SESSION_CHECKPOINT_VERSION } from "#execution/session/handoff.js";

const USAGE = {
  cacheReadTokens: 10,
  cacheWriteTokens: 0,
  costUsd: 0.5,
  inputTokens: 1_200,
  outputTokens: 300,
  sawCost: true,
};

/** An idle checkpoint in the shape an eve 0.83 owner hands over. */
function v26Checkpoint(
  input: {
    readonly context?: Record<string, unknown>;
    readonly state?: Record<string, unknown>;
  } = {},
) {
  return {
    admittedDeliveryKeys: ["delivery-alice"],
    history: [
      { content: "Alice asks for a summary.", kind: "user", role: "user" },
      { content: [{ text: "Here is the summary.", type: "text" }], role: "assistant" },
    ],
    serializedContext: {
      "app.preferences": { tone: "brief" },
      "eve.auth": null,
      "eve.bundle": { source: { kind: "bundled" } },
      "eve.channel": {
        kind: "channel:discord",
        state: { channelId: "dm-1", directMessage: true, guildId: null },
      },
      "eve.runtimeModelMetadataCache": { "openai/gpt": { contextWindowTokens: 1 } },
      "eve.sessionDynamicToolMetadata": [],
      "eve.sessionTitle": "Alice asks for a summary.",
      ...input.context,
    },
    sessionState: {
      continuationToken: "",
      hasProxyInputRequests: false,
      sessionId: "session-1",
      snapshot: {
        session: {
          agent: { system: "Be helpful." },
          continuationToken: "",
          sessionId: "session-1",
          state: {
            "app.counter": 4,
            "eve.harness.requestEnvelopeTokens": 120,
            "eve.harness.sessionProjection": {
              authorizations: {},
              calls: {},
              candidates: {},
              inputs: {},
              nextSequence: 3,
              started: true,
              tasks: {},
              turns: {},
            },
            "eve.harness.sessionUsageWindowIndex": 1,
            "eve.harness.sessionUsageWindowStart": { ...USAGE, inputTokens: 1_000 },
            "eve.harness.turnState": { grants: ["deploy:api"], suspended: [] },
            "eve.harness.turnUsage": { ...USAGE, session: USAGE, turnId: "turn_2" },
            "eve.memory": { locks: {}, operationDigests: { write: "digest" } },
            ...input.state,
          },
        },
      },
      version: 2,
    },
    sessionTimeoutMs: false,
    version: 17,
  };
}

describe("migrateSessionCheckpoint from an eve 0.83 owner", () => {
  it("carries an idle session over and leaves its projection to the stream", () => {
    const result = migrateSessionCheckpoint(v26Checkpoint());
    if (result.kind !== "current") throw new Error(result.detail);

    const usage = {
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      costUsd: 0.5,
      inputTokens: 1_200,
      outputTokens: 300,
    };
    expect(result.v26).toEqual({
      nextTurnSequence: 3,
      usage,
      usageWindow: { index: 1, start: { ...usage, inputTokens: 1_000 } },
    });
    expect(result.checkpoint).toEqual({
      ...v26Checkpoint(),
      serializedContext: {
        "app.preferences": { tone: "brief" },
        "eve.auth": null,
        "eve.bundle": { source: { kind: "bundled" } },
        // A DM's sign-in privacy follows the channel type v27 reads.
        "eve.channel": {
          kind: "channel:discord",
          state: { channelId: "dm-1", channelType: 1, guildId: null },
        },
        "eve.sessionTitle": "Alice asks for a summary.",
      },
      sessionState: {
        ...v26Checkpoint().sessionState,
        snapshot: {
          session: {
            agent: { system: "Be helpful." },
            continuationToken: "",
            sessionId: "session-1",
            state: { "app.counter": 4 },
          },
        },
      },
      version: SESSION_CHECKPOINT_VERSION,
    });
  });

  it.each([
    [
      "channel:slack",
      { channelId: "C1", taskCards: { turn_0: { messageTs: "1.2" } } },
      { channelId: "C1", taskCards: null },
    ],
    [
      "channel:teams",
      { conversationId: "thread", pendingAuthActivityId: null },
      { conversationId: "thread" },
    ],
    [
      "channel:telegram",
      {
        chatId: "chat",
        nextHitlCallbackId: 7,
        hitlCallbacks: { "eve_hitl:6": { requestId: "settled", optionId: "approve" } },
      },
      { chatId: "chat", nextHitlCallbackId: 7 },
    ],
    [
      "channel:linq",
      { thread: { id: "thread" }, streamStepIndex: null },
      { thread: { id: "thread" } },
    ],
    [
      "channel:photon",
      { thread: { id: "thread" }, streamStepIndex: null },
      { thread: { id: "thread" } },
    ],
    [
      "channel:custom",
      { routing: { thread: "thread", audience: "private" }, appState: 4 },
      { routing: { thread: "thread", audience: "private" }, appState: 4 },
    ],
  ])("upgrades settled %s state without losing its routing", (kind, state, expected) => {
    const result = migrateSessionCheckpoint(
      v26Checkpoint({
        context: {
          "eve.channel": { kind, state },
        },
      }),
    );
    if (result.kind !== "current") throw new Error(result.detail);
    expect(result.checkpoint.serializedContext["eve.channel"]).toEqual({ kind, state: expected });
  });

  it.each([
    ["channel:discord", { hitlPrompts: { approval: { messageId: "message" } } }],
    ["channel:discord", { pendingAuthMessageIds: { service: "message" } }],
    ["channel:slack", { pendingApprovalCards: { approval: {} } }],
    ["channel:slack", { pendingAuthMessageTs: { service: "1.2" } }],
    ["channel:slack", { pendingTaskResults: { names: ["worker"], turnId: "turn_0" } }],
    ["channel:teams", { pendingAuthActivityId: "activity" }],
    ["channel:teams", { pendingPromptCards: { approval: {} } }],
    ["channel:telegram", { hitlPrompts: { approval: {} } }],
    ["channel:telegram", { pendingFreeformReplies: { message: "question" } }],
    ["channel:telegram", { pendingAuthMessageIds: { service: "message" } }],
    ["channel:linq", { pendingInputCards: { message: {} } }],
    ["channel:photon", { pendingAuthMessageIds: { service: "message" } }],
    ["channel:chat-sdk", { anchorMessageId: "message", streamStepIndex: 0 }],
    ["channel:github", { shownPromptId: "question" }],
    ["channel:linear", { shownPromptId: "question" }],
    ["channel:twilio", { shownPromptId: "question" }],
    ["channel:renamed-discord", { directMessage: true }],
    ["channel:renamed-telegram", { hitlCallbacks: { callback: { requestId: "old" } } }],
    ["channel:renamed-slack", { taskCards: { turn_0: {} } }],
    ["channel:discord", { directMessage: true, channelType: 0 }],
  ])("refuses ambiguous or pending %s channel state", (kind, state) => {
    expect(
      migrateSessionCheckpoint(
        v26Checkpoint({
          context: {
            "eve.channel": { kind, state },
          },
        }),
      ),
    ).toMatchObject({ kind: "incompatible" });
  });

  it.each([
    ["a turn is open", { state: { "eve.harness.sessionProjection": { activeTurnId: "turn_2" } } }],
    [
      "input waits behind a turn",
      { state: { "eve.harness.turnState": { grants: [], queued: {}, suspended: [] } } },
    ],
    ["a request is open", { state: { "eve.runtime.hitl.requests": { approvals: {} } } }],
    ["input is pending", { state: { "eve.runtime.pendingInputBatches": [{ requests: [] }] } }],
    [
      "a workflow tool runs",
      { state: { "eve.workflowTool": { runs: [{ callId: "call" }], version: 4 } } },
    ],
    [
      "a resumable task keeps its run",
      {
        state: {
          "eve.taskTable": {
            tasks: [{ calls: [], results: [], run: { hookToken: "hook", runId: "run" } }],
            version: 1,
          },
        },
      },
    ],
    ["a memory slot is locked", { state: { "eve.memory": { locks: { slot: {} } } } }],
    ["the framework state is unknown", { state: { "eve.harness.futureRegistry": {} } }],
    ["a parent drives the session", { context: { "eve.parentSession": { sessionId: "parent" } } }],
    [
      "a remote caller drives the session",
      { context: { "eve.sessionCallback": { url: "https://agent.example" } } },
    ],
    [
      "the channel is a subagent's",
      { context: { "eve.channel": { kind: "subagent", state: {} } } },
    ],
    ["a tool interrupt is pending", { context: { "eve.pendingToolInterrupts": [{}] } }],
    ["the framework context is unknown", { context: { "eve.futureCache": {} } }],
    [
      "a Slack approval card is open",
      {
        context: {
          "eve.channel": { kind: "slack", state: { pendingApprovalCards: { request: {} } } },
        },
      },
    ],
  ])("keeps the session on its owner when %s", (_name, input) => {
    expect(migrateSessionCheckpoint(v26Checkpoint(input))).toMatchObject({
      kind: "incompatible",
      detail: expect.stringMatching(/^checkpoint version 17: /),
    });
  });
});
