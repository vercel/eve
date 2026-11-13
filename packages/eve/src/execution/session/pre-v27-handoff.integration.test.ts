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
      // The successor's first line follows the v26 lines: it compacts the earlier conversation.
      expect(followUp[0]?.meta.position.line).toBe(KITCHEN_SINK.length);
      const types = followUp.map((event) => event.type);
      expect(types.indexOf("context.settled")).toBeLessThan(types.indexOf("turn.started"));
      expect(followUp).toContainEqual(
        expect.objectContaining({
          type: "context.settled",
          data: expect.objectContaining({ kind: "compaction", outcome: "completed" }),
        }),
      );
      // The follow-up turn takes the next number and follows the earlier owner's last turn.
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
      // The import already started a fresh run, so its compaction moves the session nowhere: once
      // the follow-up parks, the successor itself runs the next message.
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
      // A reader of the whole stream sees the v26 conversation and the new turns as one session.
      const history: SessionStreamEvent[] = [];
      for await (const event of streamSessionEvents(sessionId, { follow: false })) {
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

it("moves a session past an idle subagent and ends the subagent's run on the earlier build", async () => {
  const runtime = await createTestRuntime({ agent: { name: "pre-v27-handoff-idle-task" } });
  await runtime.run(async () => {
    // The helper answered Alice earlier; on 0.83 its run stays parked on its control hook.
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
      // The successor told the old run to end; a cancel would leave a resumable task parked.
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

/**
 * An eve 0.83 owner (handoff version 3), whose session stream holds `records`, keeps its addresses
 * while the successor starts; the successor takes them over and the owner exits.
 */
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
  const owner = await start(sessionCommandInboxWorkflow, [{ token: alias }]);
  const sessionId = owner.runId;
  const commandToken = sessionCommandHookToken(sessionId);
  await waitForHook(owner, { token: sessionInboxHookToken(commandToken) });
  await waitForHook(owner, { token: sessionInboxHookToken(alias) });
  await recordLines(sessionId, records);
  const successor = await start(workflowEntry, [
    {
      activationToken: `${sessionId}:handoff:0`,
      attemptKey: `${sessionId}:0`,
      checkpoint: savedCheckpoint(sessionId, turnCount, state),
      delivery: followUpDelivery(),
      handoffVersion: 3,
      hookTokens: [commandToken, alias],
      kind: "handoff",
      ownerDeploymentId: "dpl_b",
      sessionId,
      sessionWritable: getRun(sessionId).getWritable<Uint8Array>(),
      sourceRunId: sessionId,
    },
  ]);
  return { owner, sessionId, successor };
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
  // A write resolves before its line is stored; an owner hands off only after its lines are.
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

/** The events of the first turn written from `startIndex`, through its settlement. */
async function readTurn(sessionId: string, startIndex: number): Promise<SessionStreamEvent[]> {
  const reader = readSessionEventStream(sessionId, startIndex).getReader();
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

/** The version 17 checkpoint an idle eve 0.83 owner hands off after `turnCount` turns. */
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
