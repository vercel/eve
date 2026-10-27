import { expect, it, vi } from "vitest";

import { streamSessionEvents } from "#execution/session-event-stream.js";
import { workflowEntry } from "#execution/session/entry.js";
import { KITCHEN_SINK } from "#execution/v26-history.fixtures.js";
import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, handoffFollowUp } from "#internal/testing/entry-test-helpers.js";
import { parkedAnchorWorkflow } from "#internal/testing/session-inbox-workflow.js";
import { startSessionOwner, waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, start } from "#internal/workflow/runtime.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { SessionCheckpoint } from "#execution/session/handoff.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

it("continues an idle eve 0.83 session after the v26 history its stream holds", async () => {
  const runtime = await createTestRuntime({ agent: { name: "v26-handoff" } });
  await runtime.run(async () => {
    // The original run anchors the stream an eve 0.83 owner wrote in v26 lines.
    const anchor = await start(parkedAnchorWorkflow, [{ token: "v26-handoff:anchor" }]);
    await waitForHook(anchor, { token: "v26-handoff:anchor" });
    await recordV26Lines(anchor.runId, KITCHEN_SINK);
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const successor = await startSessionOwner(workflowEntry, [
      {
        activationToken: "v26-handoff:activation",
        checkpoint: v26Checkpoint(anchor.runId),
        // A version 2 owner released the session's addresses before starting its successor.
        handoffVersion: 2,
        kind: "handoff",
        ownerDeploymentId: "dpl_b",
        reason: "prewarm",
        sessionId: anchor.runId,
        sessionWritable: getRun(anchor.runId).getWritable<Uint8Array>(),
      },
    ]);
    try {
      const inboxToken = sessionInboxHookToken(sessionCommandHookToken(anchor.runId));
      await vi.waitFor(async () =>
        expect((await waitForCommandHookOwner(inboxToken)).runId).toBe(successor.runId),
      );
      await workflowRuntime.dispatchSession({
        command: handoffFollowUp("dpl_b", "Bob asks for the next milestone.", "delivery-bob"),
        sessionId: anchor.runId,
      });
      const events = await readUntilTurnSettles(anchor.runId, "turn_12");

      const v26Turns = KITCHEN_SINK.flatMap((record) => {
        const { data, type } = record as { data?: { turnId?: string }; type: string };
        return type === "turn.started" ? [data?.turnId] : [];
      });
      expect(v26Turns).not.toContain("turn_12");
      // The successor's first line takes the next stored position.
      const firstWritten = events.find((event) => event.meta.position.line >= KITCHEN_SINK.length);
      expect(firstWritten).toMatchObject({
        data: { deliveryId: "delivery-bob" },
        meta: { position: { index: 0, line: KITCHEN_SINK.length } },
        type: "delivery.admitted",
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.started",
          data: expect.objectContaining({ follows: v26Turns.at(-1), turnId: "turn_12" }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "delivery.consumed",
          data: expect.objectContaining({
            parts: [expect.objectContaining({ text: "Bob asks for the next milestone." })],
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.settled",
          data: expect.objectContaining({ outcome: "completed", turnId: "turn_12" }),
        }),
      );
    } finally {
      await successor.cancel().catch(() => {});
      await anchor.cancel().catch(() => {});
    }
  });
});

/** Writes stored records to the session stream one per line, as a v26 owner did. */
async function recordV26Lines(sessionId: string, records: readonly unknown[]): Promise<void> {
  const writer = getRun(sessionId).getWritable<Uint8Array>().getWriter();
  try {
    for (const record of records)
      await writer.write(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
  } finally {
    writer.releaseLock();
  }
}

async function readUntilTurnSettles(
  sessionId: string,
  turnId: string,
): Promise<SessionStreamEvent[]> {
  const events: SessionStreamEvent[] = [];
  const signal = AbortSignal.timeout(60_000);
  for await (const event of streamSessionEvents(sessionId, { signal })) {
    events.push(event);
    if (event.type === "turn.settled" && event.data.turnId === turnId) return events;
  }
  throw new Error(`The session's stream ended before ${turnId} settled.`);
}

/**
 * The idle checkpoint an eve 0.83 owner hands over after the history above. Typed as the current
 * checkpoint: a successor receives whichever version its source wrote.
 */
function v26Checkpoint(sessionId: string): SessionCheckpoint {
  const checkpoint = {
    admittedDeliveryKeys: [],
    history: [
      { content: "hello there", kind: "user", role: "user" },
      { content: [{ text: "Echo: hello there", type: "text" }], role: "assistant" },
    ],
    serializedContext: {
      ...buildSerializedContext({ acceptedDeploymentId: "dpl_a", channelKind: "http" }),
      "eve.runtimeModelMetadataCache": {},
      "eve.sessionDynamicToolMetadata": [],
    },
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
            "eve.harness.sessionProjection": {
              authorizations: {},
              calls: {},
              candidates: {},
              inputs: {},
              nextSequence: 12,
              started: true,
              tasks: {},
              turns: {},
            },
          },
        },
      },
      version: 2,
    },
    sessionTimeoutMs: false,
    version: 17,
  };
  return checkpoint as unknown as SessionCheckpoint;
}
