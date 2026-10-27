import { expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { readSessionEventStream, streamSessionEvents } from "#execution/session-event-stream.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { findSessionHookHolder } from "#execution/session-inbox/owner.js";
import { workflowEntry } from "#execution/session/entry.js";
import { KITCHEN_SINK, PENDING_APPROVAL } from "#execution/v26-history.fixtures.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { releasingSessionOwnerWorkflow } from "#internal/testing/session-inbox-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, resumeHook, start } from "#internal/workflow/runtime.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

const FOLLOW_UP = "Bob asks for the weekend forecast.";

it("continues an idle session an eve before v27 recorded on the same stream", async () => {
  const runtime = await createTestRuntime({ agent: { name: "pre-v27-handoff" } });
  await runtime.run(async () => {
    const turnCount = turnsIn(KITCHEN_SINK);
    const { activation, owner, sessionId, successor } = await handOff(KITCHEN_SINK, turnCount);
    try {
      expect(activation).toEqual({ kind: "active" });
      const followUp = await readTurn(sessionId, KITCHEN_SINK.length);
      // The successor's first line follows the v26 lines, and its turn takes the next number.
      expect(followUp[0]?.meta.position.line).toBe(KITCHEN_SINK.length);
      expect(new Set(followUp.map(turnIdOf).filter(Boolean))).toEqual(
        new Set([`turn_${turnCount}`]),
      );
      expect(followUp).toContainEqual(
        expect.objectContaining({
          type: "content.completed",
          data: expect.objectContaining({ value: expect.stringContaining(FOLLOW_UP) }),
        }),
      );
      // A reader of the whole stream sees the v26 conversation and the new turn as one session.
      const history: SessionStreamEvent[] = [];
      for await (const event of streamSessionEvents(sessionId, { follow: false })) {
        history.push(event);
      }
      const lines = history.map((event) => event.meta.position.line);
      expect(lines).toEqual([...lines].sort((a, b) => a - b));
      const turns = history.filter((event) => event.type === "turn.started").map(turnIdOf);
      expect(new Set(turns).size).toBe(turns.length);
      expect(turns.at(-1)).toBe(`turn_${turnCount}`);
    } finally {
      await successor.cancel().catch(() => {});
      await owner.cancel().catch(() => {});
    }
  });
});

it("keeps a session whose v26 stream holds an open approval on its owner", async () => {
  const runtime = await createTestRuntime({ agent: { name: "pre-v27-handoff-busy" } });
  await runtime.run(async () => {
    const { activation, owner, sessionId, successor } = await handOff(
      PENDING_APPROVAL,
      turnsIn(PENDING_APPROVAL),
    );
    try {
      expect(activation).toMatchObject({ kind: "incompatible", reason: "checkpoint-version" });
      await successor.returnValue;
      // The successor wrote nothing to the stream the owner still serves.
      await expect(readTail(sessionId)).resolves.toBe(PENDING_APPROVAL.length);
    } finally {
      await owner.cancel().catch(() => {});
    }
  });
});

/**
 * An owner from before handoff version 3, like eve 0.79, whose session stream holds `records` as
 * an eve before v27 recorded them, hands its session to this build: it releases its addresses and
 * waits for the successor's verdict.
 */
async function handOff(records: readonly unknown[], turnCount: number) {
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
      checkpoint: v17Checkpoint(sessionId, turnCount),
      delivery: followUpDelivery(),
      handoffVersion: 2,
      kind: "handoff",
      ownerDeploymentId: "dpl_b",
      sessionId,
      sessionWritable: getRun(sessionId).getWritable<Uint8Array>(),
    },
  ]);
  const { activation } = await owner.returnValue;
  return { activation, owner, sessionId, successor };
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

async function readTail(sessionId: string): Promise<number> {
  const readable = getRun(sessionId).getReadable();
  try {
    return (await readable.getTailIndex()) + 1;
  } finally {
    await readable.cancel().catch(() => {});
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

/** The checkpoint an idle eve 0.83 owner hands off after `turnCount` turns. */
function v17Checkpoint(sessionId: string, turnCount: number) {
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
          },
        },
      },
      version: 2,
    },
    sessionTimeoutMs: 60_000,
    version: 17,
  } as never;
}
