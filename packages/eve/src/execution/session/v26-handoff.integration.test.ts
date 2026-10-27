import { expect, it, vi } from "vitest";

import { streamSessionEvents } from "#execution/session-event-stream.js";
import { workflowEntry } from "#execution/session/entry.js";
import capture0820 from "./v26-fixtures/0.82.0.json" with { type: "json" };
import capture0830 from "./v26-fixtures/0.83.0.json" with { type: "json" };
import capture0831 from "./v26-fixtures/0.83.1.json" with { type: "json" };
import capture0832 from "./v26-fixtures/0.83.2.json" with { type: "json" };
import capture0833 from "./v26-fixtures/0.83.3.json" with { type: "json" };
import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { handoffFollowUp } from "#internal/testing/entry-test-helpers.js";
import {
  parkedAnchorWorkflow,
  sessionCommandInboxWorkflow,
} from "#internal/testing/session-inbox-workflow.js";
import { startSessionOwner, waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, start } from "#internal/workflow/runtime.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { SessionCheckpoint } from "#execution/session/handoff.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  readTurnStepStates,
  waitForParkedTurnStep,
} from "#internal/testing/session-test-helpers.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { telegramChannel } from "#public/channels/telegram/telegramChannel.js";

it.each([capture0820, capture0830, capture0831, capture0832, capture0833])(
  "continues the checkpoint and stream captured from eve $version",
  async ({ checkpoint: capturedCheckpoint, records }) => {
    const runtime = await createTestRuntime({ agent: { name: "v26-handoff" } });
    await runtime.run(async () => {
      // Bind the released owner's checkpoint to a real stream without rewriting its private state.
      const anchor = await start(parkedAnchorWorkflow, [{ token: "v26-handoff:anchor" }]);
      await waitForHook(anchor, { token: "v26-handoff:anchor" });
      await recordV26Lines(anchor.runId, records);
      const checkpoint = JSON.parse(
        JSON.stringify(capturedCheckpoint).replaceAll("captured-session", anchor.runId),
      ) as SessionCheckpoint;
      const workflowRuntime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const source = await start(sessionCommandInboxWorkflow, [
        {
          sessionId: anchor.runId,
          token: "v26-handoff:source-alias",
        },
      ]);
      await waitForHook(source, {
        token: sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
      });
      const successor = await startSessionOwner(workflowEntry, [
        {
          activationToken: "v26-handoff:activation",
          checkpoint,
          handoffVersion: 3,
          sourceRunId: source.runId,
          hookTokens: [sessionCommandHookToken(anchor.runId), "v26-handoff:source-alias"],
          attemptKey: `${source.runId}:0`,
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
        await expect(
          workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_b", "Bob asks for the next milestone.", "delivery-bob"),
            sessionId: anchor.runId,
          }),
        ).resolves.toMatchObject({ status: "accepted", sessionId: anchor.runId });
        const events = await readUntilTurnSettles(anchor.runId, "turn_1");

        const v26Turns = records.flatMap((record) => {
          const { data, type } = record as { data?: { turnId?: string }; type: string };
          return type === "turn.started" ? [data?.turnId] : [];
        });
        expect(v26Turns).toEqual(["turn_0"]);
        // The successor's first line takes the next stored position.
        const firstWritten = events.find((event) => event.meta.position.line >= records.length);
        expect(firstWritten).toMatchObject({
          data: { deliveryId: "delivery-bob" },
          meta: { position: { index: 0, line: records.length } },
          type: "delivery.admitted",
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "turn.started",
            data: expect.objectContaining({ follows: "turn_0", turnId: "turn_1" }),
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
            data: expect.objectContaining({ outcome: "completed", turnId: "turn_1" }),
          }),
        );
        await waitForParkedTurnStep(successor.runId);
        const saved = (await readTurnStepStates(successor.runId)).at(-1)!;
        expect(saved.history.slice(0, capturedCheckpoint.history.length)).toEqual(
          capturedCheckpoint.history,
        );
        const projection = saved.sessionState.snapshot.session.state?.[
          "eve.harness.sessionProjection"
        ] as SessionProjection;
        const previousUsage =
          capturedCheckpoint.sessionState.snapshot.session.state["eve.harness.turnUsage"].session;
        const freshUsage = events
          .filter(
            (event) =>
              event.type === "usage.recorded" && event.meta.position.line >= records.length,
          )
          .flatMap((event) => (event.type === "usage.recorded" ? [event.data.usage] : []));
        expect(freshUsage.length).toBeGreaterThan(0);
        expect(projection.view.usage.total).toMatchObject({
          inputTokens:
            previousUsage.inputTokens +
            freshUsage.reduce((sum, usage) => sum + usage.inputTokens, 0),
          outputTokens:
            previousUsage.outputTokens +
            freshUsage.reduce((sum, usage) => sum + usage.outputTokens, 0),
        });
      } finally {
        await successor.cancel().catch(() => {});
        await source.cancel().catch(() => {});
        await anchor.cancel().catch(() => {});
      }
    });
  },
);

it("refuses pending channel work before taking any of the source's addresses", async () => {
  const runtime = await createTestRuntime({
    agent: { name: "v26-refused-handoff" },
    modules: [
      {
        logicalPath: "channels/telegram.ts",
        loadNamespace: async () => ({
          default: telegramChannel({
            api: {
              fetch: async () => {
                throw new Error("The handoff must not call Telegram.");
              },
            },
          }),
        }),
      },
    ],
  });
  await runtime.run(async () => {
    const alias = "v26-refused:alias";
    const source = await startSessionOwner(sessionCommandInboxWorkflow, [{ token: alias }]);
    const stable = sessionCommandHookToken(source.runId);
    await waitForHook(source, { token: sessionInboxHookToken(alias) });
    await recordV26Lines(source.runId, capture0833.records);
    const checkpoint = JSON.parse(
      JSON.stringify(capture0833.checkpoint).replaceAll("captured-session", source.runId),
    ) as SessionCheckpoint;
    const successor = await startSessionOwner(workflowEntry, [
      {
        activationToken: "v26-refused:activation",
        attemptKey: `${source.runId}:0`,
        checkpoint: {
          ...checkpoint,
          serializedContext: {
            ...checkpoint.serializedContext,
            "eve.channel": {
              kind: "channel:telegram",
              state: {
                chatId: "chat",
                chatType: "private",
                conversationId: null,
                messageThreadId: null,
                hitlPrompts: { question: { messageId: "message" } },
              },
            },
          },
        },
        handoffVersion: 3,
        hookTokens: [stable, alias],
        kind: "handoff",
        ownerDeploymentId: "dpl_b",
        reason: "prewarm",
        sessionId: source.runId,
        sessionWritable: getRun(source.runId).getWritable<Uint8Array>(),
        sourceRunId: source.runId,
      },
    ]);
    try {
      const outcome = await Promise.race([
        successor.returnValue.then(() => "successor-refused"),
        source.returnValue.then(() => "source-lost-ownership"),
      ]);
      expect(outcome).toBe("successor-refused");
      for (const token of [stable, alias]) {
        expect((await waitForCommandHookOwner(sessionInboxHookToken(token))).runId).toBe(
          source.runId,
        );
      }
      const workflowRuntime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      await expect(
        workflowRuntime.dispatchSession({
          command: handoffFollowUp(
            "dpl_a",
            "Alice continues on the original deployment.",
            "delivery-alice",
          ),
          sessionId: source.runId,
        }),
      ).resolves.toMatchObject({ status: "accepted", sessionId: source.runId });
    } finally {
      await successor.cancel().catch(() => {});
      await source.cancel().catch(() => {});
    }
  });
});

/** Writes stored records to the session stream one per line, as a v26 owner did. */
async function recordV26Lines(sessionId: string, records: readonly unknown[]): Promise<void> {
  const ops: Promise<unknown>[] = [];
  const writer = getRun(sessionId).getWritable<Uint8Array>({ ops }).getWriter();
  try {
    for (const record of records)
      await writer.write(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
  } finally {
    writer.releaseLock();
  }
  await Promise.all(ops);
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
