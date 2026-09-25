import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session/timeout.js";
import { describe, expect, it, vi } from "vitest";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import { hydrateStepReturnValue, hydrateWorkflowArguments } from "@workflow/core/serialization";
import { captureTurnEvents } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { waitForParkedTurnStep } from "#internal/testing/session-test-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import {
  buildSerializedContext,
  handoffFollowUp,
  listCallerStepNames,
} from "#internal/testing/entry-test-helpers.js";

describe("workflowEntry integration", () => {
  describe("deployment handoff", () => {
    it.each([undefined, 60_000, false] as const)(
      "renews the configured lifetime across handoffs and keeps the original stream (%s)",
      async (sessionTimeoutMs) => {
        const runtime = await createTestRuntime({ agent: { name: "workflow-entry-handoff" } });

        await runtime.run(async () => {
          const anchor = await start(workflowEntry, [
            {
              kind: "initial",
              sessionTimeoutMs,
              ownerDeploymentId: "dpl_a",
              input: { message: "hello from a" },
              serializedContext: buildSerializedContext({
                acceptedDeploymentId: "dpl_a",
                channelKind: "http",
                mode: "conversation",
              }),
            },
          ]);
          const stream = captureTurnEvents(anchor);
          const world = await getWorld();
          const workflowRuntime = createWorkflowRuntime({
            compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
          });
          let completed = false;
          try {
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            await waitForParkedTurnStep(anchor.runId);

            const originalTimer =
              sessionTimeoutMs === false ? undefined : await readSessionTimer(anchor.runId);

            await expect(
              workflowRuntime.dispatchSession({
                command: handoffFollowUp("dpl_b", "hello from b", "delivery-b"),
                sessionId: anchor.runId,
              }),
            ).resolves.toMatchObject({ sessionId: anchor.runId, status: "accepted" });

            const secondTurn = await stream.nextTurn();
            expect(secondTurn.at(-1)?.type).toBe("session.waiting");
            expect(
              secondTurn.some(
                (event) =>
                  event.type === "message.completed" &&
                  event.data.message?.includes("hello from b") === true,
              ),
            ).toBe(true);

            // The stable inbox now belongs to a successor run; the original run
            // holds only its anchor (plus the SDK's abort-signal hook from its
            // own earlier turn).
            const successor = await waitForCommandHookOwner(
              sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
            );
            expect(successor.runId).not.toBe(anchor.runId);
            const successorTimer =
              sessionTimeoutMs === false ? undefined : await readSessionTimer(successor.runId);
            if (
              sessionTimeoutMs !== false &&
              originalTimer !== undefined &&
              successorTimer !== undefined
            ) {
              expect(successorTimer.deadline.getTime()).toBeGreaterThan(
                originalTimer.deadline.getTime(),
              );
              const owner = await world.runs.get(successor.runId);
              expect(successorTimer.deadline.getTime()).toBeGreaterThanOrEqual(
                (owner.startedAt ?? owner.createdAt).getTime() +
                  (sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
              );
              await vi.waitFor(async () =>
                expect((await world.runs.get(originalTimer.runId)).status).toBe("cancelled"),
              );
            }
            // A timer from the old owner can win its race with cancellation.
            await resumeHook(sessionInboxHookToken(sessionCommandHookToken(anchor.runId)), {
              kind: "session-timeout",
              ownerRunId: anchor.runId,
            });
            // The successor can finish its turn before the old owner resumes
            // from activation and disposes its temporary handoff hook.
            await vi.waitFor(async () => {
              const anchorHooks = await world.hooks.list({ runId: anchor.runId });
              expect(
                anchorHooks.data
                  .map((hook) => hook.token)
                  .filter((token) => !token.startsWith("abrt_")),
              ).toEqual([`${anchor.runId}:anchor`]);
            });

            // A third delivery through the stable session id reaches the successor
            // and still streams on the original run.
            await expect(
              workflowRuntime.dispatchSession({
                command: handoffFollowUp("dpl_b", "third message", "delivery-c"),
                sessionId: anchor.runId,
              }),
            ).resolves.toMatchObject({ status: "accepted" });
            const thirdTurn = await stream.nextTurn();
            expect(
              thirdTurn.some(
                (event) =>
                  event.type === "message.completed" &&
                  event.data.message?.includes("third message") === true,
              ),
            ).toBe(true);

            if (successorTimer !== undefined) {
              expect(await readSessionTimer(successor.runId)).toEqual(successorTimer);
            }
            await waitForParkedTurnStep(successor.runId, 2);
            await workflowRuntime.dispatchSession({
              command: handoffFollowUp("dpl_c", "fourth message", "delivery-d"),
              sessionId: anchor.runId,
            });
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            const nextOwner = await waitForCommandHookOwner(
              sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
            );
            expect(nextOwner.runId).not.toBe(successor.runId);
            await vi.waitFor(async () =>
              expect((await world.runs.get(successor.runId)).status).toBe("completed"),
            );
            expect((await world.runs.get(anchor.runId)).status).toBe("running");
            expect(
              (await world.steps.list({ runId: successor.runId })).data.some((step) =>
                step.stepName.endsWith("//signalSessionAnchorStep"),
              ),
            ).toBe(false);
            if (sessionTimeoutMs !== false && successorTimer !== undefined) {
              const nextTimer = await readSessionTimer(nextOwner.runId);
              const owner = await world.runs.get(nextOwner.runId);
              expect(nextTimer.deadline.getTime()).toBeGreaterThan(
                successorTimer.deadline.getTime(),
              );
              expect(nextTimer.deadline.getTime()).toBeGreaterThanOrEqual(
                (owner.startedAt ?? owner.createdAt).getTime() +
                  (sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
              );
              await vi.waitFor(async () =>
                expect((await world.runs.get(successorTimer.runId)).status).toBe("cancelled"),
              );
            } else {
              for (const runId of [anchor.runId, successor.runId, nextOwner.runId]) {
                const steps = await world.steps.list({ runId });
                expect(
                  steps.data.some((step) => step.stepName.endsWith("//startSessionTimeoutStep")),
                ).toBe(false);
              }
            }

            await waitForParkedTurnStep(nextOwner.runId);
            await workflowRuntime.dispatchSession({
              command: handoffFollowUp("dpl_d", "fifth message", "delivery-e"),
              sessionId: anchor.runId,
            });
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            const finalOwner = await waitForCommandHookOwner(
              sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
            );
            expect(finalOwner.runId).not.toBe(nextOwner.runId);
            await vi.waitFor(async () =>
              expect((await world.runs.get(nextOwner.runId)).status).toBe("completed"),
            );
            expect((await world.runs.get(anchor.runId)).status).toBe("running");
            expect(
              (await world.steps.list({ runId: nextOwner.runId })).data.some((step) =>
                step.stepName.endsWith("//signalSessionAnchorStep"),
              ),
            ).toBe(false);

            // Reset ends the session on the final owner; the anchor closes the stream once.
            await workflowRuntime.dispatchSession({
              command: { kind: "reset", reason: "handoff test" },
              sessionId: anchor.runId,
            });
            await expect(anchor.returnValue).resolves.toEqual({ output: "" });
            completed = true;
            expect(await listCallerStepNames(anchor.runId)).toEqual([]);
          } finally {
            stream.dispose();
            if (!completed) await anchor.cancel();
          }
        });
      },
    );
  });
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
