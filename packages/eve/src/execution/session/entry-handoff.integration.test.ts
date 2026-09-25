import type { HandoffWorkflowEntryInput } from "#execution/session/entry-input.js";
import type { RunCreatedEventRequest } from "@workflow/world";
import { assert, describe, expect, it, vi } from "vitest";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import {
  dehydrateWorkflowArguments,
  hydrateStepReturnValue,
  hydrateWorkflowArguments,
} from "@workflow/core/serialization";
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
import { buildSerializedContext, handoffFollowUp } from "#internal/testing/entry-test-helpers.js";

describe("workflowEntry integration", () => {
  describe("deployment handoff", () => {
    it("recovers the original owner when target rejects nested state", async () => {
      const runtime = await createTestRuntime({ agent: { name: "handoff-validation" } });
      await runtime.run(async () => {
        const anchor = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_a",
            sessionTimeoutMs: false,
            input: { message: "Alice opens a research session." },
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
        const rewritten = new Map<string, Promise<unknown>>();
        let candidateId: string | undefined;
        // Model a value readable by the source but incompatible with the target.
        // Only the candidate snapshot changes; the source retains its healthy state.
        const incompatibleInput = (runId: string, encoded: unknown): Promise<unknown> => {
          let pending = rewritten.get(runId);
          if (pending === undefined) {
            pending = (async () => {
              const args = (await hydrateWorkflowArguments(encoded, runId, undefined)) as [
                HandoffWorkflowEntryInput,
              ];
              expect(args[0].kind).toBe("handoff");
              candidateId = runId;
              const session = args[0].checkpoint.sessionState.snapshot.session;
              Object.assign(session, {
                state: {
                  ...session.state,
                  "eve.workflowTool": {
                    version: 3,
                    runs: [
                      {
                        callId: "task",
                        toolName: "research",
                        lifetime: "session" as const,
                        origin: { turnId: "turn", stepIndex: 0 },
                        address: { runId: "run", hookToken: 42 },
                        task: {
                          taskId: "task",
                          metadata: { kind: "tool", name: "research" },
                          outcome: {
                            status: "cancelled",
                          },
                          dispatchContext: { auth: { current: null, initiator: null } },
                        },
                      },
                    ],
                  },
                },
              });

              const operations: Promise<void>[] = [];
              const result = await dehydrateWorkflowArguments(args, runId, undefined, operations);
              await Promise.all(operations);
              return result;
            })();
            rewritten.set(runId, pending);
          }
          return pending;
        };
        const createEvent = world.events.create.bind(world.events);
        const created = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
          const [runId] = args;
          const event = args[1] as (typeof args)[1] | RunCreatedEventRequest;
          if (event.eventType === "run_created" && event.eventData.deploymentId === "dpl_b") {
            event.eventData.input = await incompatibleInput(runId, event.eventData.input);
          }
          return createEvent(...args);
        });
        const queue = world.queue.bind(world);
        const queued = vi.spyOn(world, "queue").mockImplementation(async (...args) => {
          const message = args[1] as {
            runId?: string;
            runInput?: { deploymentId?: string; input: unknown };
          };
          if (message.runId !== undefined && message.runInput?.deploymentId === "dpl_b") {
            message.runInput.input = await incompatibleInput(message.runId, message.runInput.input);
          }
          return queue(...args);
        });
        try {
          await stream.nextTurn();
          await waitForParkedTurnStep(anchor.runId);
          await workflowRuntime.dispatchSession({
            command: handoffFollowUp(
              "dpl_b",
              "Bob requests the next research step.",
              "validation-trigger",
            ),
            sessionId: anchor.runId,
          });
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          assert(candidateId !== undefined);
          expect(
            (
              await waitForCommandHookOwner(
                sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
              )
            ).runId,
          ).toBe(anchor.runId);
          expect(
            created.mock.calls.some(
              ([runId, event]) => runId === candidateId && event.eventType === "hook_created",
            ),
          ).toBe(false);
          const candidateHooks = await world.hooks.list({ runId: candidateId });
          expect(candidateHooks.data).toEqual([]);
          const turns = await vi.waitFor(
            async () => {
              const steps = await world.steps.list({ runId: anchor.runId, resolveData: "all" });
              const turns = steps.data.filter((step) => step.stepName.endsWith("//turnStep"));
              expect(turns).toHaveLength(2);
              // The waiting event is streamed before the step's return value is persisted.
              expect(turns.every((step) => step.output !== undefined)).toBe(true);
              return turns;
            },
            { timeout: 5000 },
          );
          const histories = await Promise.all(
            turns.map(async (step) => {
              const output = await hydrateStepReturnValue(step.output, anchor.runId, undefined);
              return output.sessionState.snapshot.session.history as Array<{
                role: string;
                content: unknown;
              }>;
            }),
          );
          const deliveries = histories.map((history) =>
            history.filter(
              (message) =>
                message.role === "user" &&
                JSON.stringify(message.content).includes("Bob requests the next research step."),
            ),
          );
          expect(deliveries.map((messages) => messages.length).sort()).toEqual([0, 1]);
        } finally {
          created.mockRestore();
          queued.mockRestore();
          await workflowRuntime.dispatchSession({
            command: { kind: "reset", reason: "validation test" },
            sessionId: anchor.runId,
          });
          await anchor.returnValue;
          stream.dispose();
        }
      });
    });

    it("retains a message accepted just before durable hook disposal", async () => {
      const runtime = await createTestRuntime({ agent: { name: "workflow-entry-handoff" } });

      await runtime.run(async () => {
        const anchor = await start(workflowEntry, [
          {
            kind: "initial",
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
        let injected = false;
        const createEvent = world.events.create.bind(world.events);
        const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
          const [runId, event] = args;
          if (
            !injected &&
            runId === anchor.runId &&
            event.eventType === "hook_disposed" &&
            event.eventData?.token === sessionInboxHookToken(sessionCommandHookToken(anchor.runId))
          ) {
            injected = true;
            for (let index = 0; index < 3; index++) {
              await resumeHook(sessionInboxHookToken(sessionCommandHookToken(anchor.runId)), {
                kind: "send",
                payload: { message: `Alice sends input ${index} during release.` },
                turnPolicy: "queue",
              });
            }
          }
          return await createEvent(...args);
        });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          await waitForParkedTurnStep(anchor.runId);

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

          expect(injected).toBe(true);
          spy.mockRestore();
          const owner = await waitForCommandHookOwner(
            sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
          );
          expect(owner.runId).toBe(anchor.runId);
          await workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_b", "Bob sends a later sentinel.", "sentinel"),
            sessionId: anchor.runId,
          });
          await stream.nextTurn();
          let saved: string | undefined;
          await vi.waitFor(
            async () => {
              const steps = await world.steps.list({
                runId: owner.runId,
                resolveData: "all",
                pagination: { limit: 1000 },
              });
              for (const step of steps.data) {
                if (!step.stepName.endsWith("//turnStep") || step.output === undefined) continue;
                const result = await hydrateStepReturnValue(step.output, owner.runId, undefined);
                const history = JSON.stringify(result.sessionState.snapshot.session.history);
                if (history.includes("Bob sends a later sentinel.")) saved = history;
              }
              expect(saved).toBeDefined();
            },
            { timeout: 5000 },
          );
          for (let index = 0; index < 3; index++) {
            expect(saved).toContain(`Alice sends input ${index} during release.`);
          }
          expect(saved!.indexOf("Alice sends input 0")).toBeLessThan(
            saved!.indexOf("Alice sends input 1"),
          );
          expect(saved!.indexOf("Alice sends input 1")).toBeLessThan(
            saved!.indexOf("Alice sends input 2"),
          );
        } finally {
          spy.mockRestore();
          stream.dispose();
          if ((await anchor.status) === "running") await anchor.cancel();
        }
      });
    });

    it("hands off an alias-addressed session and keeps the alias resolving through the gap", async () => {
      const runtime = await createTestRuntime({ agent: { name: "workflow-entry-handoff-alias" } });
      const continuationToken = "http:workflow-entry-handoff-alias";

      await runtime.run(async () => {
        const anchor = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_a",
            input: { message: "hello from a" },
            serializedContext: buildSerializedContext({
              acceptedDeploymentId: "dpl_a",
              channelKind: "http",
              continuationToken,
              mode: "conversation",
            }),
          },
        ]);
        const stream = captureTurnEvents(anchor);
        const world = await getWorld();
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        // A channel delivery lands on the alias while the old owner has released
        // it and the successor has not yet claimed it. The handoff marker must
        // make ingress wait for the successor instead of reporting the session
        // gone (which would let the channel start a replacement session).
        let gapDelivery: Promise<unknown> | undefined;
        const createBatch = world.events.createBatch;
        world.events.createBatch = undefined;
        const createEvent = world.events.create.bind(world.events);
        const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
          const [runId, event] = args;
          const created = await createEvent(...args);
          if (
            gapDelivery === undefined &&
            runId === anchor.runId &&
            event.eventType === "hook_disposed" &&
            event.eventData?.token === sessionInboxHookToken(continuationToken)
          ) {
            gapDelivery = workflowRuntime.dispatchContinuation({
              command: handoffFollowUp("dpl_b", "Alice writes during the gap.", "delivery-gap"),
              continuationToken,
            });
          }
          return created;
        });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          await waitForParkedTurnStep(anchor.runId);

          await expect(
            workflowRuntime.dispatchContinuation({
              command: handoffFollowUp("dpl_b", "hello from b", "delivery-b"),
              continuationToken,
            }),
          ).resolves.toMatchObject({ sessionId: anchor.runId, status: "accepted" });

          const secondTurn = await stream.nextTurn();
          expect(
            secondTurn.some(
              (event) =>
                event.type === "message.completed" &&
                event.data.message?.includes("hello from b") === true,
            ),
          ).toBe(true);
          spy.mockRestore();
          expect(gapDelivery).toBeDefined();
          await expect(gapDelivery).resolves.toMatchObject({
            sessionId: anchor.runId,
            status: "accepted",
          });
          const gapTurn = await stream.nextTurn();
          expect(
            gapTurn.some(
              (event) =>
                event.type === "message.completed" &&
                event.data.message?.includes("Alice writes during the gap.") === true,
            ),
          ).toBe(true);

          const successor = await waitForCommandHookOwner(
            sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
          );
          expect(successor.runId).not.toBe(anchor.runId);
          await expect(
            waitForCommandHookOwner(sessionInboxHookToken(continuationToken)),
          ).resolves.toMatchObject({ runId: successor.runId });
          // No marker outlives the handoff.
          const markers = (await world.hooks.list({ runId: anchor.runId })).data.filter((hook) =>
            hook.token.startsWith("eve:inbox:handoff:"),
          );
          expect(markers).toEqual([]);
          // Only one session exists for this alias.
          await expect(workflowRuntime.resolveContinuation(continuationToken)).resolves.toEqual({
            sessionId: anchor.runId,
          });
        } finally {
          spy.mockRestore();
          world.events.createBatch = createBatch;
          stream.dispose();
          await anchor.cancel();
        }
      });
    });

    it("keeps the session on the current owner when it is not idle", async () => {
      const runtime = await createTestRuntime({ agent: { name: "workflow-entry-handoff-busy" } });

      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_a",
            input: { message: "hello from a" },
            serializedContext: buildSerializedContext({
              acceptedDeploymentId: "dpl_a",
              channelKind: "http",
              mode: "conversation",
            }),
          },
        ]);
        const stream = captureTurnEvents(run);
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");

          // Two deliveries accepted back to back: the second is pending when the
          // first is evaluated, so neither may trigger a handoff.
          await Promise.all([
            workflowRuntime.dispatchSession({
              command: handoffFollowUp("dpl_b", "first burst", "delivery-1"),
              sessionId: run.runId,
            }),
            workflowRuntime.dispatchSession({
              command: handoffFollowUp("dpl_b", "second burst", "delivery-2"),
              sessionId: run.runId,
            }),
          ]);
          const turn = await stream.nextTurn();
          expect(turn.at(-1)?.type).toBe("session.waiting");
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          const owner = await waitForCommandHookOwner(
            sessionInboxHookToken(sessionCommandHookToken(run.runId)),
          );
          expect(owner.runId).toBe(run.runId);
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    });
  });
});
