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
  releasingSessionOwnerWorkflow,
  sessionCommandInboxWorkflow,
} from "#internal/testing/session-inbox-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, resumeHook, start } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

const FOLLOW_UP = "Bob asks for the weekend forecast.";

it.each([
  ["an eve 0.79 owner, which releases its addresses first", handOffReleased],
  ["an eve 0.83 owner, whose addresses the successor takes over", handOffForced],
])("continues an idle session from %s on the same stream", async (_name, handOff) => {
  const runtime = await createTestRuntime({ agent: { name: "pre-v27-handoff" } });
  await runtime.run(async () => {
    const turnCount = turnsIn(KITCHEN_SINK);
    const { owner, sessionId, successor } = await handOff(KITCHEN_SINK, turnCount);
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

it("tells an owner that still runs a task to try again on a later delivery", async () => {
  const runtime = await createTestRuntime({ agent: { name: "pre-v27-handoff-busy" } });
  await runtime.run(async () => {
    const task = { calls: [], id: "t", results: [], run: { hookToken: "h", runId: "r" } };
    const { activation, owner, sessionId } = await handOffReleasedWith(KITCHEN_SINK, {
      "eve.taskTable": { tasks: [task], version: 1 },
    });
    try {
      // Not `incompatible`, which the owner would remember for this deployment.
      expect(activation).toMatchObject({ kind: "failed" });
      const readable = getRun(sessionId).getReadable();
      try {
        expect(await readable.getTailIndex()).toBe(KITCHEN_SINK.length - 1);
      } finally {
        await readable.cancel().catch(() => {});
      }
    } finally {
      await owner.cancel().catch(() => {});
    }
  });
});

/**
 * An eve 0.69–0.82 owner (handoff version 2), whose session stream holds `records`, hands its
 * session to this build: it releases its addresses and waits for the successor's verdict.
 */
async function handOffReleased(records: readonly unknown[], turnCount: number) {
  const { activation, ...handoff } = await handOffReleasedWith(records, {}, turnCount);
  expect(activation).toEqual({ kind: "active" });
  return handoff;
}

async function handOffReleasedWith(
  records: readonly unknown[],
  state: Record<string, unknown>,
  turnCount = turnsIn(records),
) {
  const release = `pre-v27-release-${crypto.randomUUID()}`;
  const owner = await start(releasingSessionOwnerWorkflow, [{ aliases: [], release }]);
  const sessionId = owner.runId;
  const commandToken = sessionInboxHookToken(sessionCommandHookToken(sessionId));
  await waitForHook(owner, { token: commandToken });
  await waitForHook(owner, { token: release });
  await recordLines(sessionId, records);
  await resumeHook(release, undefined);
  await vi.waitFor(async () => expect(await findSessionHookHolder(commandToken)).toBeUndefined());
  const successor = await start(workflowEntry, [
    {
      activationToken: `${sessionId}:handoff`,
      checkpoint: savedCheckpoint(14, sessionId, turnCount, state),
      delivery: followUpDelivery(),
      handoffVersion: 2,
      kind: "handoff",
      ownerDeploymentId: "dpl_b",
      sessionId,
      sessionWritable: getRun(sessionId).getWritable<Uint8Array>(),
    },
  ]);
  const { activation } = (await owner.returnValue) as { readonly activation: unknown };
  return { activation, owner, sessionId, successor };
}

/**
 * An eve 0.83 owner (handoff version 3), whose session stream holds `records`, keeps its addresses
 * while the successor starts; the successor takes them over and the owner exits.
 */
async function handOffForced(records: readonly unknown[], turnCount: number) {
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
      checkpoint: savedCheckpoint(17, sessionId, turnCount),
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
  await owner.returnValue;
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

/**
 * The checkpoint an idle owner before v27 hands off after `turnCount` turns: eve 0.79 writes
 * version 14, which predates the admitted delivery keys eve 0.83's version 17 carries.
 */
function savedCheckpoint(
  version: 14 | 17,
  sessionId: string,
  turnCount: number,
  state: Record<string, unknown> = {},
) {
  return {
    ...(version === 17 && { admittedDeliveryKeys: [] }),
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
    version,
  } as never;
}
