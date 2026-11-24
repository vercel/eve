import { builtInHosts } from "#runtime/app.js";
import { expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { readSessionEventStream, streamSessionEvents } from "#execution/session-event-stream.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { findSessionHookHolder } from "#execution/session-inbox/owner.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { KITCHEN_SINK } from "#execution/v26-history.fixtures.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, handoffFollowUp } from "#internal/testing/entry-test-helpers.js";
import { waitForParkedTurnStep } from "#internal/testing/session-test-helpers.js";
import {
  parkedTaskRunWorkflow,
  sessionCommandInboxWorkflow,
} from "#internal/testing/session-inbox-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, start } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

const FOLLOW_UP = "Bob asks for the weekend forecast.";

it("continues an idle session from an eve 0.83 owner on the same stream", async () => {
  const runtime = await createTestRuntime({ agent: { name: "pre-v27-handoff" } });
  await runtime.run(async () => {
    const turnCount = turnsIn(KITCHEN_SINK);
    const { owner, sessionId, successor } = await handOffForced(KITCHEN_SINK, turnCount);
    try {
      const followUp = await readTurn(sessionId, KITCHEN_SINK.length);
      expect(followUp[0]?.meta.position.line).toBe(KITCHEN_SINK.length);
      const types = followUp.map((event) => event.type);
      expect(types.indexOf("context.settled")).toBeLessThan(types.indexOf("turn.started"));
      expect(followUp).toContainEqual(
        expect.objectContaining({
          type: "context.settled",
          data: expect.objectContaining({ kind: "compaction", outcome: "completed" }),
        }),
      );
      expect(followUp).toContainEqual(
        expect.objectContaining({
          type: "turn.started",
          data: expect.objectContaining({
            follows: `turn_${turnCount - 1}`,
            turnId: `turn_${turnCount}`,
          }),
        }),
      );
      expect(followUp).toContainEqual(
        expect.objectContaining({
          type: "content.completed",
          data: expect.objectContaining({ value: expect.stringContaining(FOLLOW_UP) }),
        }),
      );
      await waitForParkedTurnStep(successor.runId, 2);
      const nextLine = (followUp.at(-1)?.meta.position.line ?? 0) + 1;
      await createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      }).dispatchSession({
        command: handoffFollowUp("dpl_b", "Bob asks about Sunday.", "delivery-next"),
        sessionId,
      });
      await readTurn(sessionId, nextLine);
      const commandToken = sessionInboxHookToken(sessionCommandHookToken(sessionId));
      expect((await findSessionHookHolder(commandToken))?.runId).toBe(successor.runId);
      const history: SessionStreamEvent[] = [];
      for await (const event of streamSessionEvents(builtInHosts(), sessionId, { follow: false })) {
        history.push(event);
      }
      const lines = history.map((event) => event.meta.position.line);
      expect(lines).toEqual([...lines].sort((a, b) => a - b));
      const turns = history.filter((event) => event.type === "turn.started").map(turnIdOf);
      expect(new Set(turns).size).toBe(turns.length);
      expect(turns.slice(-2)).toEqual([`turn_${turnCount}`, `turn_${turnCount + 1}`]);
    } finally {
      await successor.cancel().catch(() => {});
      await owner.cancel().catch(() => {});
    }
  });
});

it("starts the next turn without waiting out the ended source's watch interval", async () => {
  const runtime = await createTestRuntime({ agent: { name: "pre-v27-handoff-ended" } });
  await runtime.run(async () => {
    const turnCount = turnsIn(KITCHEN_SINK);
    const { owner, sessionId, successor } = await handOffForced(KITCHEN_SINK, turnCount);
    try {
      const followUp = await readTurn(sessionId, KITCHEN_SINK.length);
      await waitForParkedTurnStep(successor.runId, 2);
      const nextLine = (followUp.at(-1)?.meta.position.line ?? 0) + 1;
      const sentAt = Date.now();
      await createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      }).dispatchSession({
        command: handoffFollowUp("dpl_b", "Bob asks about Sunday.", "delivery-next"),
        sessionId,
      });
      await readTurn(sessionId, nextLine);
      expect(Date.now() - sentAt).toBeLessThan(5_000);
    } finally {
      await successor.cancel().catch(() => {});
      await owner.cancel().catch(() => {});
    }
  });
});

it("moves a session past an idle subagent and ends the subagent's run on the earlier build", async () => {
  const runtime = await createTestRuntime({ agent: { name: "pre-v27-handoff-idle-task" } });
  await runtime.run(async () => {
    const hookToken = `helper-control:${crypto.randomUUID()}`;
    const helper = await start(parkedTaskRunWorkflow, [{ token: hookToken }]);
    await waitForHook(helper, { token: hookToken });
    const task = {
      calls: [],
      id: "helper-1",
      kind: "agent",
      name: "helper",
      resumable: true,
      results: [],
      run: { hookToken, runId: helper.runId, started: true },
    };
    const { owner, sessionId, successor } = await startForcedHandoff(
      KITCHEN_SINK,
      turnsIn(KITCHEN_SINK),
      { "eve.taskTable": { tasks: [task], version: 1 } },
    );
    try {
      await owner.returnValue;
      await readTurn(sessionId, KITCHEN_SINK.length);
      const commandToken = sessionInboxHookToken(sessionCommandHookToken(sessionId));
      expect((await findSessionHookHolder(commandToken))?.runId).toBe(successor.runId);
      await expect(helper.returnValue).resolves.toMatchObject({ kind: "end" });
    } finally {
      await successor.cancel().catch(() => {});
      await owner.cancel().catch(() => {});
      await helper.cancel().catch(() => {});
    }
  });
});

it("leaves a session whose owner still runs a task with that owner", async () => {
  const runtime = await createTestRuntime({ agent: { name: "pre-v27-handoff-busy" } });
  await runtime.run(async () => {
    const task = { calls: [], id: "t", results: [], run: { hookToken: "h", runId: "r" } };
    const { owner, sessionId, successor } = await startForcedHandoff(
      KITCHEN_SINK,
      turnsIn(KITCHEN_SINK),
      { "eve.taskTable": { tasks: [task], version: 1 } },
    );
    try {
      await successor.returnValue;
      const commandToken = sessionInboxHookToken(sessionCommandHookToken(sessionId));
      expect((await findSessionHookHolder(commandToken))?.runId).toBe(owner.runId);
      expect(await readTailIndex(sessionId)).toBe(KITCHEN_SINK.length - 1);
    } finally {
      await owner.cancel().catch(() => {});
    }
  });
});

it("continues a session from a version 19 checkpoint that the previous build wrote", async () => {
  const runtime = await createTestRuntime({ agent: { name: "v19-handoff" } });
  await runtime.run(async () => {
    const alias = `http:v19:${crypto.randomUUID()}`;
    const { commandToken, owner, sessionId } = await startOwner(alias);
    const checkpoint: unknown = JSON.parse(
      V19_CHECKPOINT.replaceAll(V19_SESSION_ID, sessionId).replaceAll(V19_ALIAS, alias),
    );
    const successor = await start(workflowEntry, [
      successorArguments({ alias, checkpoint, commandToken, sessionId }),
    ]);
    try {
      await owner.returnValue;
      const followUp = await readTurn(sessionId, 0);
      expect(followUp).toContainEqual(
        expect.objectContaining({
          type: "turn.started",
          data: expect.objectContaining({ follows: "turn_0", turnId: "turn_1" }),
        }),
      );
      expect(followUp).toContainEqual(
        expect.objectContaining({
          type: "content.completed",
          data: expect.objectContaining({ value: expect.stringContaining(FOLLOW_UP) }),
        }),
      );
      const holder = await findSessionHookHolder(sessionInboxHookToken(commandToken));
      expect(holder?.runId).toBe(successor.runId);
    } finally {
      await successor.cancel().catch(() => {});
      await owner.cancel().catch(() => {});
    }
  });
});

async function handOffForced(records: readonly unknown[], turnCount: number) {
  const handoff = await startForcedHandoff(records, turnCount);
  await handoff.owner.returnValue;
  return handoff;
}

async function startForcedHandoff(
  records: readonly unknown[],
  turnCount: number,
  state: Record<string, unknown> = {},
) {
  const alias = `http:pre-v27:${crypto.randomUUID()}`;
  const { commandToken, owner, sessionId } = await startOwner(alias);
  await recordLines(sessionId, records);
  const successor = await start(workflowEntry, [
    successorArguments({
      alias,
      checkpoint: savedCheckpoint(sessionId, turnCount, state),
      commandToken,
      sessionId,
    }),
  ]);
  return { owner, sessionId, successor };
}

async function startOwner(alias: string) {
  const owner = await start(sessionCommandInboxWorkflow, [{ token: alias }]);
  const commandToken = sessionCommandHookToken(owner.runId);
  await waitForHook(owner, { token: sessionInboxHookToken(commandToken) });
  await waitForHook(owner, { token: sessionInboxHookToken(alias) });
  return { commandToken, owner, sessionId: owner.runId };
}

function successorArguments(input: {
  readonly alias: string;
  readonly checkpoint: unknown;
  readonly commandToken: string;
  readonly sessionId: string;
}) {
  const { alias, checkpoint, commandToken, sessionId } = input;
  return {
    activationToken: `${sessionId}:handoff:0`,
    attemptKey: `${sessionId}:0`,
    checkpoint: checkpoint as never,
    delivery: followUpDelivery(),
    handoffVersion: 3,
    hookTokens: [commandToken, alias],
    kind: "handoff",
    ownerDeploymentId: "dpl_b",
    sessionId,
    sessionWritable: getRun(sessionId).getWritable<Uint8Array>(),
    sourceRunId: sessionId,
  } as const;
}

async function recordLines(sessionId: string, records: readonly unknown[]): Promise<void> {
  const writer = getRun(sessionId).getWritable<Uint8Array>().getWriter();
  try {
    for (const record of records) {
      await writer.write(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
    }
  } finally {
    writer.releaseLock();
  }
  await vi.waitFor(async () => expect(await readTailIndex(sessionId)).toBe(records.length - 1), {
    timeout: 10_000,
  });
}

async function readTailIndex(sessionId: string): Promise<number> {
  const readable = getRun(sessionId).getReadable();
  try {
    return await readable.getTailIndex();
  } finally {
    await readable.cancel().catch(() => {});
  }
}

async function readTurn(sessionId: string, startIndex: number): Promise<SessionStreamEvent[]> {
  const reader = readSessionEventStream(builtInHosts(), sessionId, startIndex).getReader();
  const events: SessionStreamEvent[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("The session stream ended before the turn settled.");
      events.push(value);
      if (value.type === "turn.settled") return events;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function turnsIn(records: readonly unknown[]): number {
  return records.filter((record) => (record as { type?: unknown }).type === "turn.started").length;
}

function turnIdOf(event: SessionStreamEvent): string | undefined {
  const { data } = event as { readonly data?: { readonly turnId?: unknown } };
  return typeof data?.turnId === "string" ? data.turnId : undefined;
}

function followUpDelivery(): DeliverHookPayload {
  return {
    auth: null,
    deliveryMetadata: [
      {
        acceptedDeploymentId: "dpl_b",
        channelKind: "http",
        channelName: "test",
        deliveryId: "delivery-follow-up",
        payloadIndex: 0,
      },
    ],
    kind: "deliver",
    payloads: [{ message: FOLLOW_UP }],
  };
}

function savedCheckpoint(sessionId: string, turnCount: number, state: Record<string, unknown>) {
  return {
    admittedDeliveryKeys: [],
    history: [
      { content: "hello there", kind: "user", role: "user" },
      { content: [{ text: "Echo: hello there", type: "text" }], role: "assistant" },
    ],
    serializedContext: buildSerializedContext({
      acceptedDeploymentId: "dpl_a",
      channelKind: "http",
    }),
    sessionState: {
      continuationToken: "",
      hasProxyInputRequests: false,
      sessionId,
      snapshot: {
        session: {
          agent: { system: "Be helpful." },
          continuationToken: "",
          sessionId,
          state: {
            "eve.harness.sessionProjection": { nextSequence: turnCount, started: true, turns: {} },
            ...state,
          },
        },
      },
      version: 2,
    },
    sessionTimeoutMs: 60_000,
    version: 17,
  } as never;
}

const V19_SESSION_ID = "wrun_01M84VS9F9SBZQZ23J6SSJEXHG";
const V19_ALIAS = "http:workflow:replay-moved";
const V19_CHECKPOINT = `{
 "capabilities": {
  "requestInput": true
 },
 "retention": 0,
 "sessionTimeoutMs": 2592000000,
 "admittedDeliveryKeys": [],
 "history": [
  {
   "content": "Summary of our conversation so far:",
   "kind": "context.compaction",
   "role": "user"
  },
  {
   "content": "Noted, Alice.",
   "role": "assistant"
  },
  {
   "role": "assistant",
   "content": [
    {
     "type": "text",
     "text": "Noted, Alice."
    }
   ]
  }
 ],
 "serializedContext": {
  "eve.bundle": {
   "source": {
    "kind": "bundled"
   }
  },
  "eve.channel": {
   "kind": "http",
   "state": {}
  },
  "eve.channelInstrumentation": {
   "channelType": "http",
   "kind": "channel:http",
   "metadata": {}
  },
  "eve.conversation": {
   "audience": "unknown",
   "channel": {
    "kind": "channel:http",
    "name": "http"
   },
   "environment": "production",
   "principalType": "anonymous"
  },
  "eve.sessionTitle": "Alice asks for the summary.",
  "eve.continuationToken": "http:workflow:replay-moved",
  "eve.continuationHookTokens": [
   "http:workflow:replay-moved"
  ],
  "eve.auth": null,
  "eve.initiatorAuth": null,
  "eve.capabilities": {
   "requestInput": true
  },
  "eve.channelDelivery": {
   "channelKind": "channel:http",
   "channelName": "http",
   "deliveryId": "0e3fc208-2b4b-4501-ad31-ea0a697a4c2e"
  },
  "eve.otelTraceEnabled": false,
  "eve.sessionId": "wrun_01M84VS9F9SBZQZ23J6SSJEXHG",
  "eve.sessionInbox": {
   "sessionId": "wrun_01M84VS9F9SBZQZ23J6SSJEXHG"
  },
  "eve.callbackBaseUrl": "http://localhost:3000",
  "eve.conversationId": "wrun_01M84VS9F9SBZQZ23J6SSJEXHG",
  "eve.turnDeliveryIds": [
   "0e3fc208-2b4b-4501-ad31-ea0a697a4c2e"
  ],
  "eve.reactions": {
   "latest": {
    "session.started": 0,
    "*": 12,
    "delivery.admitted": 8,
    "turn.started": 1,
    "delivery.consumed": 1,
    "model.requested": 10,
    "model.started": 10,
    "content.delta": 4,
    "content.completed": 5,
    "model.settled": 11,
    "usage.recorded": 11,
    "turn.settled": 7,
    "delivery.settled": 12,
    "context.started": 9,
    "context.started:compaction": 9,
    "context.settled": 11,
    "context.settled:compaction": 11
   },
   "slots": {
    "model:agent": {
     "digest": "hfxLwFYgVPPoYM6q1YM1kr",
     "since": 1,
     "value": {
      "reference": {
       "id": "eve-test/workflow-replay-moved",
       "contextWindowTokens": 200000
      }
     },
     "live": true
    }
   },
   "revision": "bundled",
   "at": "2026-11-23T18:48:08.312Z"
  },
  "eve.model": {
   "reference": {
    "id": "eve-test/workflow-replay-moved",
    "contextWindowTokens": 200000
   }
  },
  "eve.historyState": {},
  "eve.stateLayout": 1
 },
 "sessionState": {
  "continuationToken": "http:workflow:replay-moved",
  "hasProxyInputRequests": false,
  "sessionId": "wrun_01M84VS9F9SBZQZ23J6SSJEXHG",
  "version": 2,
  "snapshot": {
   "session": {
    "continuationToken": "http:workflow:replay-moved",
    "sessionId": "wrun_01M84VS9F9SBZQZ23J6SSJEXHG",
    "compaction": {
     "estimateRatio": 0.0003940110323089047,
     "requestEnvelopeTokens": 2512,
     "lastStage": "tail"
    },
    "sandboxState": {
     "session": null
    },
    "state": {
     "eve.harness.sessionProjection": {
      "counters": {
       "changes": 1,
       "runs": 2
      },
      "view": {
       "calls": {},
       "changes": {},
       "children": {},
       "deliveries": {
        "0e3fc208-2b4b-4501-ad31-ea0a697a4c2e": {
         "introducedAt": 0,
         "startedAt": "2026-11-23T18:48:08.204Z",
         "deliveryId": "0e3fc208-2b4b-4501-ad31-ea0a697a4c2e",
         "source": {
          "channel": "channel:http"
         },
         "status": "settled",
         "parts": [
          {
           "kind": "text",
           "text": "Alice asks for the summary."
          }
         ],
         "turnId": "turn_0",
         "consumedAt": 1,
         "outcome": "handled",
         "closedAt": 7,
         "endedAt": "2026-11-23T18:48:08.245Z"
        },
        "bbcac318-70f3-4839-929d-6de4e5bce45d": {
         "introducedAt": 8,
         "startedAt": "2026-11-23T18:48:08.303Z",
         "deliveryId": "bbcac318-70f3-4839-929d-6de4e5bce45d",
         "source": {
          "control": "compact"
         },
         "status": "settled",
         "outcome": "applied",
         "closedAt": 12,
         "endedAt": "2026-11-23T18:48:08.312Z"
        }
       },
       "interactions": {},
       "parts": {
        "run_0.0": {
         "introducedAt": 5,
         "startedAt": "2026-11-23T18:48:08.242Z",
         "kind": "text",
         "partId": "run_0.0",
         "phase": "reply",
         "runId": "run_0",
         "value": "Noted, Alice."
        }
       },
       "position": 13,
       "responses": {},
       "runs": {
        "run_0": {
         "introducedAt": 2,
         "startedAt": "2026-11-23T18:48:08.211Z",
         "owner": {
          "turnId": "turn_0"
         },
         "runId": "run_0",
         "status": "settled",
         "step": 0,
         "attempt": 0,
         "modelId": "eve-test/workflow-replay-moved",
         "finishReason": "stop",
         "outcome": "completed",
         "closedAt": 6,
         "endedAt": "2026-11-23T18:48:08.243Z",
         "usage": {
          "cacheReadTokens": 0,
          "cacheWriteTokens": 0,
          "inputTokens": 1,
          "outputTokens": 1
         }
        }
       },
       "session": {
        "status": "open",
        "turnCount": 1,
        "runtime": {
         "agentId": "workflow-replay-moved",
         "agentName": "workflow-replay-moved",
         "eveVersion": "1.1.0"
        },
        "startedAt": "2026-11-23T18:48:08.204Z",
        "latestTurnId": "turn_0"
       },
       "tasks": {},
       "turns": {
        "turn_0": {
         "introducedAt": 1,
         "startedAt": "2026-11-23T18:48:08.208Z",
         "cause": {
          "deliveryId": "0e3fc208-2b4b-4501-ad31-ea0a697a4c2e"
         },
         "follows": null,
         "turnId": "turn_0",
         "status": "settled",
         "runs": 1,
         "reply": [
          "run_0.0"
         ],
         "outcome": "completed",
         "closedAt": 7,
         "endedAt": "2026-11-23T18:48:08.245Z"
        }
       },
       "usage": {
        "byKind": {
         "model": {
          "cacheReadTokens": 0,
          "cacheWriteTokens": 0,
          "inputTokens": 2,
          "outputTokens": 2
         }
        },
        "total": {
         "cacheReadTokens": 0,
         "cacheWriteTokens": 0,
         "inputTokens": 2,
         "outputTokens": 2
        }
       }
      },
      "outputStarted": "turn_0"
     },
     "eve.harness.reportedSessionUsage": {
      "cacheReadTokens": 0,
      "cacheWriteTokens": 0,
      "inputTokens": 2,
      "outputTokens": 2
     }
    }
   }
  }
 },
 "version": 19
}`;
