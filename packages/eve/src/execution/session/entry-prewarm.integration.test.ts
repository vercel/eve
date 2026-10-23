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
import { defineHook } from "#public/definitions/hook.js";

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

async function waitForPrewarmStep(runId: string): Promise<void> {
  const world = await getWorld();
  await vi.waitFor(
    async () => {
      const steps = await world.steps.list({ runId });
      const step = steps.data.find((entry) => entry.stepName.endsWith("//prewarmSessionStep"));
      expect(step?.status).toBe("completed");
    },
    { timeout: 10_000 },
  );
}

function sandboxHook() {
  return {
    logicalPath: "hooks/sandbox.ts",
    loadNamespace: async () => ({
      default: defineHook({
        events: {
          async "turn.started"(_event, ctx) {
            await ctx.getSandbox();
          },
        },
      }),
    }),
  };
}

describe("session prewarmers", () => {
  it("starts a prewarmed session's sandbox before its first message, which the turn resumes", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "prewarm-sandbox" },
      modules: [sandboxHook()],
    });
    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          sessionTimeoutMs: false,
          input: {},
          serializedContext: buildSerializedContext({ channelKind: "http" }),
        },
      ]);
      const stream = captureTurnEvents(run);
      const token = sessionInboxHookToken(sessionCommandHookToken(run.runId));
      const prewarmed = [`definition:${run.runId}`, `start:${run.runId}`];
      try {
        await waitForPrewarmStep(run.runId);
        expect(runtime.sandboxEvents).toEqual(prewarmed);
        await resumeHook(token, {
          kind: "send",
          payload: { message: "Alice opens the project notes." },
        });
        await stream.nextTurn();
        expect(runtime.sandboxEvents).toEqual([...prewarmed, `resume:${run.runId}`]);
        await resumeHook(token, { kind: "reset" });
        await expect(run.returnValue).resolves.toEqual({ output: "" });
        expect(runtime.sandboxCleanups).toEqual([run.runId]);
      } finally {
        stream.dispose();
        if ((await run.status) === "running") await run.cancel();
      }
    });
  });

  it("runs a first message sent while the sandbox starts without waiting, and cleans up after it", async () => {
    const started = Promise.withResolvers<void>();
    const runtime = await createTestRuntime({
      agent: { name: "prewarm-sandbox-race" },
      beforeSandboxStart: () => started.promise,
    });
    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          sessionTimeoutMs: false,
          input: {},
          serializedContext: buildSerializedContext({ channelKind: "http" }),
        },
      ]);
      const stream = captureTurnEvents(run);
      const token = sessionInboxHookToken(sessionCommandHookToken(run.runId));
      try {
        await vi.waitFor(() => expect(runtime.sandboxEvents).toEqual([`definition:${run.runId}`]), {
          timeout: 10_000,
        });
        await resumeHook(token, {
          kind: "send",
          payload: { message: "Alice asks for a short greeting." },
        });
        const turn = await stream.nextTurn();
        expect(turn.some((event) => event.type === "message.completed")).toBe(true);
        expect(runtime.sandboxEvents).toEqual([`definition:${run.runId}`]);

        await resumeHook(token, { kind: "reset" });
        // Cleanup that did not wait for the prewarm step would run while start is held.
        await vi
          .waitFor(() => expect(runtime.sandboxEvents).toContain(`end:${run.runId}`), {
            timeout: 2_000,
          })
          .catch(() => undefined);
        started.resolve();
        await expect(run.returnValue).resolves.toEqual({ output: "" });
        // Session end waited for the prewarm step, so its cleanup removed the started sandbox.
        expect(runtime.sandboxEvents).toEqual([
          `definition:${run.runId}`,
          `start:${run.runId}`,
          `end:${run.runId}`,
        ]);
      } finally {
        started.resolve();
        stream.dispose();
        if ((await run.status) === "running") await run.cancel();
      }
    });
  });
});

describe("prewarm handoff while the prewarm step runs", () => {
  it("keeps the session on its owner until the prewarm step has started the sandbox", async () => {
    const started = Promise.withResolvers<void>();
    const runtime = await createTestRuntime({
      agent: { name: "prewarm-transfer-hold" },
      beforeSandboxStart: () => started.promise,
    });
    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
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
      const token = sessionInboxHookToken(sessionCommandHookToken(run.runId));
      const world = await getWorld();
      try {
        await vi.waitFor(() => expect(runtime.sandboxEvents).toEqual([`definition:${run.runId}`]), {
          timeout: 10_000,
        });
        await resumeHook(token, {
          kind: "session-prewarm",
          expectedOwnerRunId: run.runId,
          targetDeploymentId: "dpl_b",
        });
        // Without the hold, the session moves within a few hundred milliseconds.
        const until = Date.now() + 2_000;
        while (Date.now() < until) {
          expect((await waitForCommandHookOwner(token)).runId).toBe(run.runId);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        started.resolve();
        await resumeHook(token, { kind: "reset" });
        await expect(run.returnValue).resolves.toEqual({ output: "" });
        expect(runtime.sandboxEvents).toEqual([
          `definition:${run.runId}`,
          `start:${run.runId}`,
          `end:${run.runId}`,
        ]);
      } finally {
        started.resolve();
        if ((await world.runs.get(run.runId)).status === "running") await run.cancel();
      }
    });
  });
});

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
        // A session moves only once its prewarm step has started the sandbox.
        await waitForPrewarmStep(anchor.runId);
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
          if (!conversation) await waitForPrewarmStep(anchor.runId);
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
