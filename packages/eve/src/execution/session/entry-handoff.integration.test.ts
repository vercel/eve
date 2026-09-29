import type { HandoffWorkflowEntryInput } from "#execution/session/entry-input.js";
import type { RunCreatedEventRequest } from "@workflow/world";
import { assert, describe, expect, it, vi } from "vitest";
import { getHookByToken, getRun, getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import {
  dehydrateWorkflowArguments,
  hydrateStepReturnValue,
  hydrateWorkflowArguments,
} from "@workflow/core/serialization";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
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
  withTimeout,
} from "#internal/testing/entry-test-helpers.js";
import {
  captureConsoleOutput,
  sessionHandoffFailedNotice,
  workflowSdkNotice,
} from "#internal/testing/log-records.js";

describe("workflowEntry integration", () => {
  describe("deployment handoff", () => {
    it.each(["rejects nested state", "claims without force"] as const)(
      "recovers the original owner when target %s",
      async (incompatibility) => {
        const output = captureConsoleOutput();
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
                if (incompatibility === "claims without force") {
                  // A version 1 source's successor, or an older target, claims
                  // without force while this owner still holds every hook.
                  delete (args[0] as { handoffVersion?: number }).handoffVersion;
                } else
                  Object.assign(session, {
                    state: {
                      ...session.state,
                      "eve.workflowTool": {
                        version: 4,
                        runs: [
                          {
                            callId: "call",
                            toolName: "research",
                            origin: { turnId: "turn", stepIndex: 0 },
                            address: { runId: "run", hookToken: 42 },
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
              message.runInput.input = await incompatibleInput(
                message.runId,
                message.runInput.input,
              );
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
            const isSessionHook = (token: string | undefined) =>
              token?.startsWith("eve:inbox:") === true;
            if (incompatibility !== "claims without force") {
              expect(
                created.mock.calls.some(
                  ([runId, event]) =>
                    runId === candidateId &&
                    event.eventType === "hook_created" &&
                    isSessionHook(event.eventData.token),
                ),
              ).toBe(false);
            }
            const candidateHooks = await world.hooks.list({ runId: candidateId });
            expect(candidateHooks.data.filter((hook) => isSessionHook(hook.token))).toEqual([]);
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
        expect(output.lines).toContainEqual(
          expect.stringContaining(workflowSdkNotice.unpinnedDelivery),
        );
        // Only a rejected checkpoint fails a retried validation step.
        if (incompatibility === "rejects nested state") {
          expect(output.lines).toContainEqual(
            expect.stringContaining(workflowSdkNotice.maxRetries),
          );
        }
        expect(output.lines).toContainEqual(sessionHandoffFailedNotice);
        expect(
          output.unexpected(
            workflowSdkNotice.unpinnedDelivery,
            workflowSdkNotice.maxRetries,
            sessionHandoffFailedNotice,
          ),
        ).toEqual([]);
      },
    );

    it("forwards messages accepted just before the takeover to the successor in order", async () => {
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
            }),
          },
        ]);
        const stream = captureTurnEvents(anchor);
        const world = await getWorld();
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        const stableToken = sessionInboxHookToken(sessionCommandHookToken(anchor.runId));
        // The previous owner still holds the stable hook until the successor's
        // forced claim commits, so these land with it and must be forwarded.
        let injected = false;
        const createBatch = world.events.createBatch;
        world.events.createBatch = undefined;
        const createEvent = world.events.create.bind(world.events);
        const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
          const [runId, event] = args;
          if (
            !injected &&
            runId !== anchor.runId &&
            event.eventType === "hook_created" &&
            event.eventData.token === stableToken
          ) {
            injected = true;
            for (let index = 0; index < 3; index++) {
              await resumeHook(stableToken, {
                kind: "send",
                payload: { message: `Alice sends input ${index} during the takeover.` },
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
          const owner = await waitForCommandHookOwner(stableToken);
          expect(owner.runId).not.toBe(anchor.runId);
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
                if (history.includes("Alice sends input 2")) saved = history;
              }
              expect(saved).toBeDefined();
            },
            { timeout: 5000 },
          );
          expect(saved!.indexOf("hello from b")).toBeLessThan(
            saved!.indexOf("Alice sends input 0"),
          );
          expect(saved!.indexOf("Alice sends input 0")).toBeLessThan(
            saved!.indexOf("Alice sends input 1"),
          );
          expect(saved!.indexOf("Alice sends input 1")).toBeLessThan(
            saved!.indexOf("Alice sends input 2"),
          );
          // The previous owner forwarded them; it never processed them itself.
          const anchorTurns = (await world.steps.list({ runId: anchor.runId })).data.filter(
            (step) => step.stepName.endsWith("//turnStep"),
          );
          expect(anchorTurns).toHaveLength(1);
        } finally {
          spy.mockRestore();
          world.events.createBatch = createBatch;
          stream.dispose();
          if ((await anchor.status) === "running") await anchor.cancel();
        }
      });
    });

    it("hands off an alias-addressed session without ever leaving the alias unowned", async () => {
      const output = captureConsoleOutput();
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
            }),
          },
        ]);
        const stream = captureTurnEvents(anchor);
        const world = await getWorld();
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        // A channel delivery lands on the alias the moment the successor's
        // forced claim takes it. The token always resolves to some owner, so
        // ingress never needs a marker or a retry to accept it.
        let gapDelivery: Promise<unknown> | undefined;
        const markers: string[] = [];
        const createBatch = world.events.createBatch;
        world.events.createBatch = undefined;
        const createEvent = world.events.create.bind(world.events);
        const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
          const [runId, event] = args;
          const created = await createEvent(...args);
          if (event.eventType !== "hook_created") return created;
          if (event.eventData.token.startsWith("eve:inbox:handoff:")) {
            markers.push(event.eventData.token);
          }
          if (
            gapDelivery === undefined &&
            runId !== anchor.runId &&
            event.eventData.token === sessionInboxHookToken(continuationToken)
          ) {
            gapDelivery = workflowRuntime.dispatchContinuation({
              command: handoffFollowUp(
                "dpl_b",
                "Alice writes during the takeover.",
                "delivery-gap",
              ),
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
                event.data.message?.includes("Alice writes during the takeover.") === true,
            ),
          ).toBe(true);

          const successor = await waitForCommandHookOwner(
            sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
          );
          expect(successor.runId).not.toBe(anchor.runId);
          await expect(
            waitForCommandHookOwner(sessionInboxHookToken(continuationToken)),
          ).resolves.toMatchObject({ runId: successor.runId });
          // Only the legacy release-first path marks an unowned address.
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
      expect(output.lines).toContainEqual(
        expect.stringContaining(workflowSdkNotice.unpinnedDelivery),
      );
      expect(output.unexpected(workflowSdkNotice.unpinnedDelivery)).toEqual([]);
    });

    it.each([
      ["while the first successor owns the session", false],
      ["after the first successor handed off and exited", true],
    ] as const)(
      "keeps the session when the same successor boots again %s",
      async (_when, late) => {
        const runtime = await createTestRuntime({
          agent: { name: "workflow-entry-handoff-duplicate" },
        });

        await runtime.run(async () => {
          const anchor = await start(workflowEntry, [
            {
              kind: "initial",
              ownerDeploymentId: "dpl_a",
              sessionTimeoutMs: false,
              input: { message: "Alice opens a session." },
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
          // A start step can run again after its first run already started the
          // successor, so the same successor input can boot twice, at any time.
          let successorStart: { runId: string; input: unknown } | undefined;
          let duplicateRunId: string | undefined;
          const duplicateClaims: string[] = [];
          const createBatch = world.events.createBatch;
          world.events.createBatch = undefined;
          const createEvent = world.events.create.bind(world.events);
          const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
            const [runId] = args;
            const event = args[1] as (typeof args)[1] | RunCreatedEventRequest;
            if (event.eventType === "run_created" && event.eventData.deploymentId === "dpl_b") {
              successorStart ??= { runId, input: event.eventData.input };
            }
            if (
              runId === duplicateRunId &&
              event.eventType === "hook_created" &&
              event.eventData.token.startsWith("eve:inbox:")
            ) {
              duplicateClaims.push(event.eventData.token);
            }
            return createEvent(...args);
          });
          const stableToken = sessionInboxHookToken(sessionCommandHookToken(anchor.runId));
          try {
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            await waitForParkedTurnStep(anchor.runId);
            await workflowRuntime.dispatchSession({
              command: handoffFollowUp(
                "dpl_b",
                "Bob asks from the next deployment.",
                "duplicate-trigger",
              ),
              sessionId: anchor.runId,
            });
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            const successor = await waitForCommandHookOwner(stableToken);
            expect(successor.runId).not.toBe(anchor.runId);
            await waitForParkedTurnStep(successor.runId);

            let owner = successor.runId;
            let ownerDeployment = "dpl_b";
            if (late) {
              await workflowRuntime.dispatchSession({
                command: handoffFollowUp("dpl_c", "Bob moves on again.", "duplicate-later-handoff"),
                sessionId: anchor.runId,
              });
              expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
              const next = await waitForCommandHookOwner(stableToken);
              expect(next.runId).not.toBe(successor.runId);
              await vi.waitFor(async () =>
                expect((await world.runs.get(successor.runId)).status).toBe("completed"),
              );
              await waitForParkedTurnStep(next.runId);
              owner = next.runId;
              ownerDeployment = "dpl_c";
            }

            assert(successorStart !== undefined);
            const [input] = (await hydrateWorkflowArguments(
              successorStart.input,
              successorStart.runId,
              undefined,
            )) as [HandoffWorkflowEntryInput];
            const duplicate = await start(workflowEntry, [
              { ...input, sessionWritable: getRun(anchor.runId).getWritable<Uint8Array>() },
            ]);
            duplicateRunId = duplicate.runId;
            await vi.waitFor(
              async () => expect(["completed", "failed"]).toContain(await duplicate.status),
              { timeout: 30_000 },
            );
            // The duplicate left quietly without claiming any session address.
            expect(await duplicate.status).toBe("completed");
            expect(duplicateClaims).toEqual([]);
            expect(await anchor.status).toBe("running");
            expect((await waitForCommandHookOwner(stableToken)).runId).toBe(owner);

            await expect(
              workflowRuntime.dispatchSession({
                command: handoffFollowUp(
                  ownerDeployment,
                  "Alice follows up.",
                  "duplicate-follow-up",
                ),
                sessionId: anchor.runId,
              }),
            ).resolves.toMatchObject({ status: "accepted" });
            const next = await withTimeout(stream.nextTurn(), "turn after duplicate successor");
            expect(filterEventsByType(next, "session.failed")).toEqual([]);
            expect(filterEventsByType(next, "session.completed")).toEqual([]);
            expect(
              next.some(
                (event) =>
                  event.type === "message.completed" &&
                  event.data.message?.includes("Alice follows up.") === true,
              ),
            ).toBe(true);
          } finally {
            spy.mockRestore();
            world.events.createBatch = createBatch;
            stream.dispose();
            if ((await anchor.status) === "running") await anchor.cancel();
          }
        });
      },
      60_000,
    );

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

    it("keeps a recovered session when a failed attempt starts again later", async () => {
      captureConsoleOutput();
      const runtime = await createTestRuntime({ agent: { name: "handoff-late-duplicate" } });
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
            }),
          },
        ]);
        const stream = captureTurnEvents(anchor);
        const world = await getWorld();
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        const stableToken = sessionInboxHookToken(sessionCommandHookToken(anchor.runId));
        // The first start of the attempt fails, standing in for any failure a
        // later start of the same attempt would not repeat.
        let firstCandidate: string | undefined;
        let original: HandoffWorkflowEntryInput | undefined;
        const rewritten = new Map<string, Promise<unknown>>();
        const failFirst = (runId: string, encoded: unknown): Promise<unknown> => {
          if (firstCandidate !== undefined && firstCandidate !== runId)
            return Promise.resolve(encoded);
          firstCandidate = runId;
          let pending = rewritten.get(runId);
          if (pending === undefined) {
            pending = (async () => {
              const args = (await hydrateWorkflowArguments(encoded, runId, undefined)) as [
                HandoffWorkflowEntryInput,
              ];
              original ??= { ...args[0], checkpoint: { ...args[0].checkpoint } };
              Object.assign(args[0].checkpoint, { version: 4 });
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
            event.eventData.input = await failFirst(runId, event.eventData.input);
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
            message.runInput.input = await failFirst(message.runId, message.runInput.input);
          }
          return queue(...args);
        });
        try {
          await stream.nextTurn();
          await waitForParkedTurnStep(anchor.runId);
          await workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_b", "Bob requests the next research step.", "trigger"),
            sessionId: anchor.runId,
          });
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          expect((await waitForCommandHookOwner(stableToken)).runId).toBe(anchor.runId);
          await waitForParkedTurnStep(anchor.runId);

          // A start step re-run after the first candidate already ended.
          assert(original !== undefined);
          const late = await start(workflowEntry, [original]);
          await vi.waitFor(
            async () => expect(["completed", "failed"]).toContain(await late.status),
            { timeout: 30_000 },
          );
          expect(await late.status).toBe("completed");
          expect((await getHookByToken(stableToken)).runId).toBe(anchor.runId);
          expect(await anchor.status).toBe("running");
        } finally {
          created.mockRestore();
          queued.mockRestore();
          stream.dispose();
          if ((await anchor.status) === "running") await anchor.cancel();
        }
      });
    }, 60_000);

    it("hands off release-first on a World without forced hook claims", async () => {
      const runtime = await createTestRuntime({ agent: { name: "handoff-release-first" } });
      await runtime.run(async () => {
        const world = await getWorld();
        const capabilities = world.capabilities;
        world.capabilities = { ...capabilities, hookForceClaim: false };
        const anchor = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_a",
            input: { message: "Alice opens a session." },
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
        const stableToken = sessionInboxHookToken(sessionCommandHookToken(anchor.runId));
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          await waitForParkedTurnStep(anchor.runId);
          await workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_b", "Bob asks from the next deployment.", "move"),
            sessionId: anchor.runId,
          });
          const turn = await stream.nextTurn();
          expect(filterEventsByType(turn, "session.failed")).toEqual([]);
          const successor = await waitForCommandHookOwner(stableToken);
          expect(successor.runId).not.toBe(anchor.runId);
          await waitForParkedTurnStep(successor.runId);

          await workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_c", "Bob moves on again.", "move-again"),
            sessionId: anchor.runId,
          });
          await stream.nextTurn();
          const next = await waitForCommandHookOwner(stableToken);
          expect([anchor.runId, successor.runId]).not.toContain(next.runId);
        } finally {
          world.capabilities = capabilities;
          stream.dispose();
          if ((await anchor.status) === "running") await anchor.cancel();
        }
      });
    }, 60_000);
  });
});
