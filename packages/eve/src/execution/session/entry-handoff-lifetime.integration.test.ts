import { afterEach, expect, it, vi } from "vitest";
import { hydrateStepReturnValue, hydrateWorkflowArguments } from "@workflow/core/serialization";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, handoffFollowUp } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { captureConsoleOutput, workflowSdkNotice } from "#internal/testing/log-records.js";
import { waitForParkedTurnStep } from "#internal/testing/session-test-helpers.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

afterEach(() => vi.restoreAllMocks());

it("restarts the idle window across a compaction handoff", async () => {
  const output = captureConsoleOutput();
  const runtime = await createTestRuntime({ agent: { name: "workflow-entry-compaction" } });
  await runtime.run(async () => {
    const world = await getWorld();
    const createEvent = world.events.create.bind(world.events);
    let delayFirstStart = true;
    vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
      if (delayFirstStart && args[1].eventType === "run_started") {
        delayFirstStart = false;
        // Separate the optimistic start time from the persisted replay timestamp.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return createEvent(...args);
    });
    const anchor = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        sessionTimeoutMs: 60_000,
        ownerDeploymentId: "dpl_a",
        input: { message: "Alice starts a long planning session." },
        serializedContext: buildSerializedContext({
          acceptedDeploymentId: "dpl_a",
          channelKind: "http",
        }),
      },
    ]);
    const stream = captureTurnEvents(anchor);
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    try {
      await stream.nextTurn();
      await waitForParkedTurnStep(anchor.runId);
      const originalTimer = await readSessionTimer(anchor.runId);
      await workflowRuntime.dispatchSession({
        command: { kind: "compact", deliveryId: "compact-delivery" },
        sessionId: anchor.runId,
      });
      await stream.nextUntil((event) => event.type === "context.settled");
      const inboxToken = sessionInboxHookToken(sessionCommandHookToken(anchor.runId));
      let successor: Awaited<ReturnType<typeof waitForCommandHookOwner>> | undefined;
      await vi.waitFor(async () => {
        successor = await waitForCommandHookOwner(inboxToken);
        expect(successor.runId).not.toBe(anchor.runId);
      });
      expect((await readSessionTimer(successor!.runId)).deadline.getTime()).toBeGreaterThan(
        originalTimer.deadline.getTime(),
      );
      await vi.waitFor(async () =>
        expect((await world.runs.get(originalTimer.runId)).status).toBe("cancelled"),
      );
      await workflowRuntime.dispatchSession({
        command: handoffFollowUp("dpl_a", "Bob asks for the next milestone.", "delivery-b"),
        sessionId: anchor.runId,
      });
      const followUp = await stream.nextTurn();
      expect(followUp).toContainEqual(
        expect.objectContaining({
          type: "content.completed",
          data: expect.objectContaining({
            value: expect.stringContaining("Bob asks for the next milestone."),
          }),
        }),
      );
    } finally {
      stream.dispose();
      await anchor.cancel().catch(() => {});
    }
  });
  expect(output.unexpected(workflowSdkNotice.unpinnedDelivery)).toEqual([]);
});

async function readSessionTimer(ownerRunId: string): Promise<{ runId: string; deadline: Date }> {
  const world = await getWorld();
  let timer: { runId: string; deadline: Date } | undefined;
  await vi.waitFor(async () => {
    const steps = await world.steps.list({ runId: ownerRunId, resolveData: "all" });
    const start = steps.data.find((step) => step.stepName.endsWith("//startSessionTimeoutStep"));
    expect(start?.output).toBeDefined();
    const result = (await hydrateStepReturnValue(start!.output, ownerRunId, undefined)) as {
      runId: string;
    };
    const run = await world.runs.get(result.runId);
    const [input] = (await hydrateWorkflowArguments(run.input, run.runId, undefined)) as [
      { deadline: Date },
    ];
    timer = { runId: run.runId, deadline: input.deadline };
  });
  return timer!;
}
