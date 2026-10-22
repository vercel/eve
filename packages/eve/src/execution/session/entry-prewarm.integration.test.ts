import { describe, expect, it, vi } from "vitest";
import type { AnyEventRequest } from "@workflow/world";
import { hydrateStepReturnValue, hydrateWorkflowArguments } from "@workflow/core/serialization";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { buildSerializedContext, handoffFollowUp } from "#internal/testing/entry-test-helpers.js";
import { waitForParkedTurnStep } from "#internal/testing/session-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import { getWorld, resumeHook } from "#internal/workflow/runtime.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { captureConsoleOutput, workflowSdkNotice } from "#internal/testing/log-records.js";

async function deadline(runId: string): Promise<Date> {
  const world = await getWorld();
  let result: Date | undefined;
  await vi.waitFor(async () => {
    const steps = await world.steps.list({ runId, resolveData: "all" });
    const start = steps.data.find((step) => step.stepName.endsWith("//startSessionTimeoutStep"));
    expect(start?.output).toBeDefined();
    const timer = (await hydrateStepReturnValue(start!.output, runId, undefined)) as {
      runId: string;
    };
    const run = await world.runs.get(timer.runId, { resolveData: "all" });
    const [input] = (await hydrateWorkflowArguments(run.input, run.runId, undefined)) as [
      { deadline: Date },
    ];
    result = input.deadline;
    expect(result).toBeInstanceOf(Date);
  });
  return result!;
}

describe("idle session prewarm handoff", () => {
  it("delivers a message exactly once when Send arrives while the successor starts", async () => {
    const output = captureConsoleOutput();
    const runtime = await createTestRuntime({ agent: { name: "typing-successor-race" } });
    await runtime.run(async () => {
      const anchor = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_a",
          sessionTimeoutMs: false,
          input: {},
          serializedContext: buildSerializedContext({
            acceptedDeploymentId: "dpl_a",
            channelKind: "http",
          }),
        },
      ]);
      const stream = captureTurnEvents(anchor);
      const world = await getWorld();
      const workflowRuntime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const token = sessionInboxHookToken(sessionCommandHookToken(anchor.runId));
      const createBatch = world.events.createBatch;
      world.events.createBatch = undefined;
      const createEvent = world.events.create.bind(world.events);
      let sending: Promise<unknown> | undefined;
      const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
        const [runId] = args;
        const event = args[1] as AnyEventRequest;
        if (
          sending === undefined &&
          runId !== anchor.runId &&
          event.eventType === "run_created" &&
          event.eventData.deploymentId === "dpl_b"
        ) {
          sending = workflowRuntime.dispatchSession({
            sessionId: anchor.runId,
            command: handoffFollowUp("dpl_b", "Alice writes during preparation.", "typing-race"),
          });
          await sending;
        }
        return await createEvent(...args);
      });
      try {
        await waitForCommandHookOwner(token);
        await resumeHook(token, {
          kind: "session-prewarm",
          expectedOwnerRunId: anchor.runId,
          targetDeploymentId: "dpl_b",
        });
        const events = await stream.nextTurn();
        expect(sending).toBeDefined();
        await expect(sending).resolves.toMatchObject({
          status: "accepted",
          sessionId: anchor.runId,
        });
        expect(
          events.filter(
            (event) =>
              event.type === "message.received" &&
              event.data.message === "Alice writes during preparation.",
          ),
        ).toHaveLength(1);
        expect(
          events.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("Alice writes") === true,
          ),
        ).toBe(true);
        expect((await waitForCommandHookOwner(token)).runId).not.toBe(anchor.runId);
        await workflowRuntime.dispatchSession({
          sessionId: anchor.runId,
          command: { kind: "reset" },
        });
        await anchor.returnValue;
      } finally {
        spy.mockRestore();
        world.events.createBatch = createBatch;
        stream.dispose();
        if ((await world.runs.get(anchor.runId)).status === "running") await anchor.cancel();
      }
    });
    expect(output.unexpected(workflowSdkNotice.unpinnedDelivery)).toEqual([]);
  });
  it.each([false, true])(
    "moves before Send, preserves expiry and stream, and ignores stale hints (conversation: %s)",
    async (conversation) => {
      const output = captureConsoleOutput();
      const runtime = await createTestRuntime({ agent: { name: "typing-prewarm" } });
      await runtime.run(async () => {
        const anchor = await startSessionOwner(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_a",
            sessionTimeoutMs: 60_000,
            input: conversation ? { message: "Alice records the research milestone." } : {},
            serializedContext: buildSerializedContext({
              acceptedDeploymentId: "dpl_a",
              channelKind: "http",
            }),
          },
        ]);
        const stream = captureTurnEvents(anchor);
        const world = await getWorld();
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        const token = sessionInboxHookToken(sessionCommandHookToken(anchor.runId));
        let successorId: string | undefined;
        try {
          await waitForCommandHookOwner(token);
          if (conversation) {
            await stream.nextTurn();
            await waitForParkedTurnStep(anchor.runId);
          }
          const originalDeadline = await deadline(anchor.runId);
          await resumeHook(token, {
            kind: "session-prewarm",
            expectedOwnerRunId: "wrun_stale",
            targetDeploymentId: "dpl_c",
          });
          await resumeHook(token, {
            kind: "session-prewarm",
            expectedOwnerRunId: anchor.runId,
            targetDeploymentId: "dpl_b",
          });
          await vi.waitFor(
            async () => {
              successorId = (await waitForCommandHookOwner(token)).runId;
              expect(successorId).not.toBe(anchor.runId);
            },
            { timeout: 10_000 },
          );
          const preparedDeadline = await deadline(successorId!);
          if (conversation) {
            // Completed turns extend the idle window; preparation itself must not renew it.
            expect(preparedDeadline.getTime()).toBeGreaterThanOrEqual(originalDeadline.getTime());
            const successor = await world.runs.get(successorId!);
            expect(preparedDeadline.getTime()).toBeLessThan(successor.createdAt.getTime() + 60_000);
          } else {
            expect(preparedDeadline).toEqual(originalDeadline);
          }
          const steps = await world.steps.list({ runId: successorId! });
          expect(
            steps.data.some(
              (step) =>
                step.stepName.includes("invokeAgent") || step.stepName.endsWith("//runTurnStep"),
            ),
          ).toBe(false);
          // A retry inspected before handoff must not move the successor backwards.
          await resumeHook(token, {
            kind: "session-prewarm",
            expectedOwnerRunId: anchor.runId,
            targetDeploymentId: "dpl_c",
          });
          await workflowRuntime.dispatchSession({
            sessionId: anchor.runId,
            command: handoffFollowUp(
              "dpl_b",
              "Alice confirms the research milestone.",
              "typing-next",
            ),
          });
          const events = await stream.nextTurn();
          expect(
            events.some(
              (event) =>
                event.type === "message.completed" &&
                event.data.message?.includes("Alice confirms") === true,
            ),
          ).toBe(true);
          expect((await waitForCommandHookOwner(token)).runId).toBe(successorId);
          expect(await deadline(successorId!)).toEqual(preparedDeadline);
          await workflowRuntime.dispatchSession({
            sessionId: anchor.runId,
            command: { kind: "reset" },
          });
          await expect(anchor.returnValue).resolves.toEqual({ output: "" });
        } finally {
          stream.dispose();
          if ((await world.runs.get(anchor.runId)).status === "running") await anchor.cancel();
        }
      });
      expect(output.unexpected(workflowSdkNotice.unpinnedDelivery)).toEqual([]);
    },
  );
});
