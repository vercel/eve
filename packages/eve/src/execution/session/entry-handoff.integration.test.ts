import { startSessionOwner, waitForHook } from "#internal/testing/workflow-test-helpers.js";
import {
  parkedAnchorWorkflow,
  releasingSessionOwnerWorkflow,
} from "#internal/testing/session-inbox-workflow.js";
import type { HandoffWorkflowEntryInput } from "#execution/session/entry-input.js";
import type { AnyEventRequest, RunCreatedEventRequest } from "@workflow/world";
import { assert, describe, expect, it, vi } from "vitest";
import { getRun, getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import { dehydrateWorkflowArguments, hydrateWorkflowArguments } from "@workflow/core/serialization";
import { captureTurnEvents } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  readTurnStepStates,
  waitForParkedTurnStep,
} from "#internal/testing/session-test-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/session/entry.js";
import { SESSION_CHECKPOINT_VERSION } from "#execution/session/handoff.js";
import {
  isSessionInboxHookToken,
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import { buildSerializedContext, handoffFollowUp } from "#internal/testing/entry-test-helpers.js";
import { SESSION_PROJECTION_STATE_KEY, storedProjection } from "#harness/session-machine/view.js";
import { captureConsoleOutput, workflowSdkNotice } from "#internal/testing/log-records.js";

const HANDOFF_LOG = "[eve:execution.handoff]";

describe("workflowEntry integration", () => {
  describe("deployment handoff", () => {
    it("remembers admitted delivery keys when the logical session changes owners", async () => {
      const runtime = await createTestRuntime({ agent: { name: "handoff-keyed-delivery" } });
      await runtime.run(async () => {
        const { anchor, stream, workflowRuntime } = await openSession({
          idempotencyKey: "opening",
        });
        try {
          await stream.nextTurn();
          await waitForParkedTurnStep(anchor.runId);
          const command = {
            ...handoffFollowUp("dpl_b", "Bob requests a report.", "keyed-report"),
            idempotencyKey: "report",
          };
          await workflowRuntime.dispatchSession({ command, sessionId: anchor.runId });
          const successor = await waitForNewOwner(anchor.runId, anchor.runId);
          await waitForUserMessages(successor.runId, "Bob requests a report.");
          await waitForParkedTurnStep(successor.runId);
          await workflowRuntime.dispatchSession({
            command: {
              ...handoffFollowUp("dpl_b", "Alice opens a research session.", "opening-retry"),
              idempotencyKey: "opening",
            },
            sessionId: anchor.runId,
          });
          await workflowRuntime.dispatchSession({ command, sessionId: anchor.runId });
          await workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_b", "Alice reviews the report.", "review"),
            sessionId: anchor.runId,
          });
          const history = await waitForUserMessages(successor.runId, "Alice reviews the report.");
          expect(countOf(history, "Bob requests a report.")).toBe(1);
          expect(countOf(history, "Alice opens a research session.")).toBe(1);
        } finally {
          stream.dispose();
          await anchor.cancel();
        }
      });
    });

    it("processes what the owner accepted during the move on the successor, after the trigger", async () => {
      const runtime = await createTestRuntime({ agent: { name: "handoff-accepted-during-move" } });
      await runtime.run(async () => {
        const { anchor, stream, workflowRuntime } = await openSession();
        const inbox = stableInbox(anchor.runId);
        // Alice's messages reach the owner while it is starting the successor.
        const world = await instrumentWorld({
          async beforeEvent(_runId, event) {
            if (!isCandidateCreated(event)) return;
            for (let index = 0; index < 3; index++)
              await resumeHook(inbox, aliceSends(`Alice sends input ${index} during the move.`));
          },
        });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          await waitForParkedTurnStep(anchor.runId);

          await expect(
            workflowRuntime.dispatchSession({
              command: handoffFollowUp("dpl_b", "Bob requests the next step.", "trigger"),
              sessionId: anchor.runId,
            }),
          ).resolves.toMatchObject({ sessionId: anchor.runId, status: "accepted" });

          const successor = await waitForNewOwner(anchor.runId, anchor.runId);
          const history = await waitForUserMessages(successor.runId, "Alice sends input 2");
          const positions = [
            "Bob requests the next step.",
            ...[0, 1, 2].map((index) => `Alice sends input ${index} during the move.`),
          ].map((message) => positionOf(history, message));
          expect(positions.every((position) => position >= 0)).toBe(true);
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
          // The trigger ran once, on the successor: the owner kept its single opening turn.
          expect(await readTurnStepStates(anchor.runId)).toHaveLength(1);
        } finally {
          world.restore();
          stream.dispose();
          await anchor.cancel();
        }
      });
    });

    it("answers alias deliveries with accepted at every step of the move", async () => {
      const output = captureConsoleOutput();
      const runtime = await createTestRuntime({ agent: { name: "handoff-alias-every-step" } });
      const continuationToken = "http:handoff-alias-every-step";
      await runtime.run(async () => {
        const { anchor, stream, workflowRuntime } = await openSession({ continuationToken });
        const deliveries: { message: string; result: Promise<unknown> }[] = [];
        let moving = false;
        // Deliveries race the move: none waits for the one before to be accepted.
        const world = await instrumentWorld({
          beforeEvent(runId, event) {
            if (isCandidateCreated(event)) moving = true;
            if (!moving) return;
            const onCandidate = runId !== anchor.runId;
            if (onCandidate && event.eventType === "step_started") {
              const stepName = (event.eventData as { stepName?: string }).stepName ?? "";
              if (stepName.endsWith("//turnStep")) moving = false;
            }
            const durable =
              event.eventType === "hook_created" ||
              event.eventType === "hook_disposed" ||
              event.eventType === "step_started" ||
              event.eventType === "step_completed";
            if (!durable) return;
            const message = `Alice writes at move step ${deliveries.length}.`;
            const result = workflowRuntime.dispatchContinuation({
              command: handoffFollowUp("dpl_b", message, `step-${deliveries.length}`),
              continuationToken,
            });
            deliveries.push({ message, result });
          },
        });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          await waitForParkedTurnStep(anchor.runId);

          await expect(
            workflowRuntime.dispatchContinuation({
              command: handoffFollowUp("dpl_b", "Bob requests the next step.", "trigger"),
              continuationToken,
            }),
          ).resolves.toMatchObject({ sessionId: anchor.runId, status: "accepted" });

          const successor = await waitForNewOwner(anchor.runId, anchor.runId);
          // The move ends when the successor starts its first turn.
          await vi.waitFor(() => expect(moving).toBe(false), { timeout: 10_000 });
          expect(deliveries.length).toBeGreaterThan(3);
          for (const { result } of deliveries) {
            await expect(result).resolves.toEqual({
              deliveryId: expect.any(String),
              sessionId: anchor.runId,
              status: "accepted",
            });
          }
          const history = await waitForUserMessages(
            successor.runId,
            ...deliveries.map(({ message }) => message),
          );
          for (const { message } of deliveries) expect(countOf(history, message), message).toBe(1);
          await expect(
            waitForCommandHookOwner(sessionInboxHookToken(continuationToken)),
          ).resolves.toMatchObject({ runId: successor.runId });
          await expect(workflowRuntime.resolveContinuation(continuationToken)).resolves.toEqual({
            sessionId: anchor.runId,
          });
        } finally {
          world.restore();
          stream.dispose();
          await anchor.cancel();
        }
      });
      expect(output.unexpected(workflowSdkNotice.unpinnedDelivery)).toEqual([]);
    });

    it("stops attempting a deployment that cannot read the checkpoint version", async () => {
      const output = captureConsoleOutput();
      const runtime = await createTestRuntime({ agent: { name: "handoff-checkpoint-version" } });
      await runtime.run(async () => {
        const { anchor, stream, workflowRuntime } = await openSession();
        // As after a rollback: the successor's build cannot read what this owner wrote.
        const world = await instrumentWorld({
          rewriteCandidate(input) {
            Object.assign(input.checkpoint, { version: SESSION_CHECKPOINT_VERSION + 1 });
            return input;
          },
        });
        try {
          await stream.nextTurn();
          await waitForParkedTurnStep(anchor.runId);
          const claimsBefore = await countSessionHookClaims(anchor.runId);
          for (const [index, message] of [
            "Bob requests the first research step.",
            "Bob requests the second research step.",
          ].entries()) {
            await workflowRuntime.dispatchSession({
              command: handoffFollowUp("dpl_b", message, `version-${index}`),
              sessionId: anchor.runId,
            });
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            await waitForParkedTurnStep(anchor.runId, index + 2);
          }
          // The remembered target is skipped before any candidate exists.
          expect(world.candidates.size).toBe(1);
          const [candidateId] = world.candidates.keys();
          const candidateEvents = await world.events(candidateId!);
          // An unreadable version is an answer, not a fault: validation runs once.
          expect(
            candidateEvents.filter(
              (event) => event.eventType === "step_failed" || event.eventType === "step_retrying",
            ),
          ).toEqual([]);
          expect((await waitForCommandHookOwner(stableInbox(anchor.runId))).runId).toBe(
            anchor.runId,
          );
          // The candidate never held a session address, so the owner reclaimed nothing.
          expect(await listSessionHookTokens(candidateId!)).toEqual([]);
          expect(await countSessionHookClaims(anchor.runId)).toBe(claimsBefore);

          // A different deployment is unproven, so it earns a fresh attempt.
          await workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_c", "Bob requests a third research step.", "version-3"),
            sessionId: anchor.runId,
          });
          await stream.nextTurn();
          await waitForNewOwner(anchor.runId, anchor.runId);
        } finally {
          world.restore();
          stream.dispose();
          await anchor.cancel();
        }
      });
      // Both sides explain the refusal once: the successor names the version it
      // cannot read and the owner names the target it keeps the session from.
      for (const prefix of ["session handoff refused", "session handoff failed"]) {
        expect(
          output.lines.filter((line) => line.startsWith(`${HANDOFF_LOG} ${prefix}`)),
        ).toHaveLength(1);
      }
      expect(output.unexpected(workflowSdkNotice.unpinnedDelivery, HANDOFF_LOG)).toEqual([]);
    });

    it("remembers a successor that claims ordinarily as unable to take over", async () => {
      const output = captureConsoleOutput();
      const runtime = await createTestRuntime({ agent: { name: "handoff-older-successor" } });
      await runtime.run(async () => {
        const { anchor, stream, workflowRuntime } = await openSession();
        // A build older than this protocol reads the input as a released source's.
        const world = await instrumentWorld({
          rewriteCandidate({ attemptKey: _attemptKey, hookTokens: _hookTokens, ...input }) {
            return { ...input, handoffVersion: 2 };
          },
        });
        try {
          await stream.nextTurn();
          await waitForParkedTurnStep(anchor.runId);
          const messages = ["Bob requests the first step.", "Bob requests the second step."];
          for (const [index, message] of messages.entries()) {
            await workflowRuntime.dispatchSession({
              command: handoffFollowUp("dpl_b", message, `older-${index}`),
              sessionId: anchor.runId,
            });
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            await waitForParkedTurnStep(anchor.runId, index + 2);
          }
          expect(world.candidates.size).toBe(1);
          expect((await waitForCommandHookOwner(stableInbox(anchor.runId))).runId).toBe(
            anchor.runId,
          );
          const history = await waitForUserMessages(anchor.runId, messages[1]!);
          for (const message of messages) expect(countOf(history, message)).toBe(1);
        } finally {
          world.restore();
          stream.dispose();
          await anchor.cancel();
        }
      });
      expect(
        output.lines.filter((line) => line.startsWith(`${HANDOFF_LOG} session handoff failed`)),
      ).toHaveLength(1);
      expect(output.unexpected(workflowSdkNotice.unpinnedDelivery, HANDOFF_LOG)).toEqual([]);
    });

    it("takes the session back from a successor that fails partway through its claims", async () => {
      const output = captureConsoleOutput();
      const runtime = await createTestRuntime({ agent: { name: "handoff-partial-claims" } });
      const continuationToken = "http:handoff-partial-claims";
      await runtime.run(async () => {
        const { anchor, stream, workflowRuntime } = await openSession({ continuationToken });
        const inbox = stableInbox(anchor.runId);
        const world = await instrumentWorld({
          // The successor takes the stable inbox, then fails to claim the next address.
          rewriteCandidate(input) {
            return { ...input, hookTokens: [sessionCommandHookToken(anchor.runId), ""] };
          },
          // Alice writes while the failing successor holds the stable inbox.
          async beforeEvent(runId, event) {
            if (runId === anchor.runId || event.eventType !== "step_started") return;
            const { stepName } = event.eventData as { stepName?: string };
            if (stepName?.endsWith("//signalSessionOwnerActivationStep") !== true) return;
            await resumeHook(inbox, aliceSends("Alice writes while the move fails."));
          },
        });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          await waitForParkedTurnStep(anchor.runId);

          await workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_b", "Bob requests the next step.", "trigger"),
            sessionId: anchor.runId,
          });
          const history = await waitForUserMessages(
            anchor.runId,
            "Alice writes while the move fails.",
          );
          expect(positionOf(history, "Bob requests the next step.")).toBeGreaterThanOrEqual(0);
          expect(positionOf(history, "Bob requests the next step.")).toBeLessThan(
            positionOf(history, "Alice writes while the move fails."),
          );
          for (const token of [inbox, sessionInboxHookToken(continuationToken)]) {
            expect((await waitForCommandHookOwner(token)).runId).toBe(anchor.runId);
          }
          const [candidateId] = world.candidates.keys();
          const backend = await getWorld();
          await vi.waitFor(async () =>
            expect((await backend.runs.get(candidateId!)).status).toBe("completed"),
          );
        } finally {
          world.restore();
          stream.dispose();
          await anchor.cancel();
        }
      });
      expect(output.unexpected(workflowSdkNotice.unpinnedDelivery, HANDOFF_LOG)).toEqual([]);
    });

    it("fences a duplicate candidate out with its attempt lease", async () => {
      const runtime = await createTestRuntime({ agent: { name: "handoff-duplicate" } });
      await runtime.run(async () => {
        const { anchor, stream, workflowRuntime } = await openSession();
        const world = await instrumentWorld({});
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          await waitForParkedTurnStep(anchor.runId);
          await workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_b", "Bob requests the next step.", "trigger"),
            sessionId: anchor.runId,
          });
          await stream.nextTurn();
          const successor = await waitForNewOwner(anchor.runId, anchor.runId);
          const original = world.candidates.get(successor.runId);
          assert(original !== undefined);

          // A start step retried after its run was created starts the same attempt again.
          const duplicate = await start(
            workflowEntry,
            [{ ...original, sessionWritable: getRun(anchor.runId).getWritable<Uint8Array>() }],
            { deploymentId: "dpl_b" },
          );
          await expect(duplicate.returnValue).resolves.toEqual({ output: "" });
          const backend = await getWorld();
          expect((await backend.hooks.list({ runId: duplicate.runId })).data).toEqual([]);
          expect((await backend.steps.list({ runId: duplicate.runId })).data).toEqual([]);
          expect((await waitForCommandHookOwner(stableInbox(anchor.runId))).runId).toBe(
            successor.runId,
          );
        } finally {
          world.restore();
          stream.dispose();
          await anchor.cancel();
        }
      });
    });
  });

  describe("late candidate", () => {
    it("shuts out a candidate that boots after its owner kept the session", async () => {
      const runtime = await createTestRuntime({ agent: { name: "handoff-late-candidate" } });
      await runtime.run(async () => {
        const { anchor, stream, workflowRuntime } = await openSession();
        const trigger = "Bob requests the next step.";
        const world = await instrumentWorld({ failCandidateStart: true });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          await waitForParkedTurnStep(anchor.runId);
          await workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_b", trigger, "trigger"),
            sessionId: anchor.runId,
          });

          // The start step created the candidate and failed; the owner won the
          // attempt's lease and ran the trigger itself.
          const history = await waitForUserMessages(anchor.runId, trigger);
          expect(countOf(history, trigger)).toBe(1);
          const created = [...world.candidates.values()].find((input) => input.kind === "handoff");
          assert(created !== undefined);
          world.restore();

          const late = await start(
            workflowEntry,
            [{ ...created, sessionWritable: getRun(anchor.runId).getWritable<Uint8Array>() }],
            { deploymentId: "dpl_b" },
          );
          await expect(late.returnValue).resolves.toEqual({ output: "" });
          const backend = await getWorld();
          expect((await backend.hooks.list({ runId: late.runId })).data).toEqual([]);
          expect((await backend.steps.list({ runId: late.runId })).data).toEqual([]);
          expect((await waitForCommandHookOwner(stableInbox(anchor.runId))).runId).toBe(
            anchor.runId,
          );
        } finally {
          world.restore();
          stream.dispose();
          await anchor.cancel();
        }
      });
    });
  });

  describe("source gone before the successor claims", () => {
    it("claims nothing when its source ended before the successor prepared", async () => {
      const runtime = await createTestRuntime({ agent: { name: "handoff-source-gone" } });
      await runtime.run(async () => {
        const { anchor, stream, workflowRuntime } = await openSession();
        let candidateRunId: string | undefined;
        // Alice's session is cancelled while its successor is still booting.
        const world = await instrumentWorld({
          async beforeEvent(runId, event) {
            if (
              runId === anchor.runId ||
              event.eventType !== "hook_created" ||
              !String(event.eventData.token).startsWith("eve:handoff:lease:")
            )
              return;
            candidateRunId = runId;
            await anchor.cancel();
          },
        });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          await waitForParkedTurnStep(anchor.runId);
          await workflowRuntime.dispatchSession({
            command: handoffFollowUp("dpl_b", "Bob requests the next step.", "trigger"),
            sessionId: anchor.runId,
          });

          await vi.waitFor(() => expect(candidateRunId).toBeDefined(), { timeout: 10_000 });
          await expect(getRun(candidateRunId!).returnValue).resolves.toEqual({ output: "" });
          expect(await countSessionHookClaims(candidateRunId!)).toBe(0);
          expect(await readTurnStepStates(candidateRunId!)).toEqual([]);
        } finally {
          world.restore();
          stream.dispose();
        }
      });
    });
  });

  // Every live session takes this path on the first deploy of this protocol:
  // its owner runs an older build, which releases its addresses before it
  // starts the successor and waits for `active`.
  describe("handoff from an owner that released its addresses", () => {
    const trigger = "Bob requests the next research step.";

    it.each([undefined, 2] as const)(
      "claims every address, tells the owner, and runs the trigger once (handoffVersion %s)",
      async (handoffVersion) => {
        const runtime = await createTestRuntime({
          agent: { name: `handoff-released-v${String(handoffVersion ?? 1)}` },
        });
        await runtime.run(async () => {
          const move = await handOffFromReleasedOwner(trigger, (input) => ({
            ...input,
            ...(handoffVersion !== undefined && { handoffVersion }),
          }));
          try {
            await expect(move.source.returnValue).resolves.toEqual({
              activation: { kind: "active" },
              released: [],
            });
            for (const token of move.addresses) {
              await expect(
                waitForCommandHookOwner(sessionInboxHookToken(token)),
              ).resolves.toMatchObject({ runId: move.successor.runId });
            }
            const history = await waitForUserMessages(move.successor.runId, trigger);
            expect(countOf(history, trigger)).toBe(1);
          } finally {
            await move.cleanup();
          }
        });
      },
    );

    it("continues an eve 0.66 checkpoint and stops its idle children", async () => {
      const output = captureConsoleOutput();
      const runtime = await createTestRuntime({ agent: { name: "handoff-eve-066-owner" } });
      await runtime.run(async () => {
        const move = await handOffFromReleasedOwner(trigger, toEve066Checkpoint);
        try {
          await expect(move.source.returnValue).resolves.toMatchObject({
            activation: { kind: "active" },
          });
          const successorSteps = await (
            await getWorld()
          ).steps.list({ runId: move.successor.runId });
          expect(
            successorSteps.data.some((step) =>
              step.stepName.endsWith("//stopUntrackedChildSessionsStep"),
            ),
          ).toBe(true);
          // The successor's turn continues the history the old owner carried.
          const history = await waitForUserMessages(move.successor.runId, trigger);
          expect(history).toEqual([
            expect.stringContaining("Alice opens a research session."),
            expect.stringContaining(trigger),
          ]);
        } finally {
          await move.cleanup();
        }
      });
      expect(output.unexpected(workflowSdkNotice.unpinnedDelivery, HANDOFF_LOG)).toEqual([]);
    });
  });
});

/**
 * Hands a real checkpoint to a current successor the way an older owner did:
 * the owner releases its addresses first and the start input carries none of
 * this protocol's fields.
 */
async function handOffFromReleasedOwner(
  trigger: string,
  shape: (input: HandoffWorkflowEntryInput) => unknown,
) {
  const checkpoint = await captureCheckpoint();
  const alias = "http:handoff-released-owner";
  const source = await start(releasingSessionOwnerWorkflow, [
    { aliases: [alias], release: `release:${alias}` },
  ]);
  const sessionId = source.runId;
  await waitForHook(source, { token: sessionInboxHookToken(alias) });
  // Stands in for the original run, which owned the session's stream.
  const streamHost = await start(parkedAnchorWorkflow, [{ token: `stream:${sessionId}` }]);
  await resumeHook(`release:${alias}`, undefined);
  await vi.waitFor(async () => expect(await listSessionHookTokens(sessionId)).toEqual([]));

  const {
    attemptKey: _attemptKey,
    handoffVersion: _handoffVersion,
    hookTokens: _hookTokens,
    sourceRunId: _sourceRunId,
    ...released
  } = {
    ...checkpoint,
    activationToken: `${sessionId}:handoff`,
    checkpoint: rebindCheckpoint(checkpoint.checkpoint, sessionId, alias),
    delivery: { kind: "deliver" as const, payloads: [{ message: trigger }] },
    reason: undefined,
    sessionId,
    sessionWritable: getRun(streamHost.runId).getWritable<Uint8Array>(),
  };
  const successor = await start(
    workflowEntry,
    [shape(released as HandoffWorkflowEntryInput) as HandoffWorkflowEntryInput],
    { deploymentId: "dpl_b" },
  );
  return {
    addresses: [sessionCommandHookToken(sessionId), alias],
    source,
    successor,
    async cleanup() {
      for (const run of [successor, streamHost, source])
        if ((await run.status) === "running") await run.cancel();
    },
  };
}

/** A settled checkpoint of a real session, as its owner sends it to a successor. */
async function captureCheckpoint(): Promise<HandoffWorkflowEntryInput> {
  const { anchor, stream, workflowRuntime } = await openSession();
  // The candidate refuses, so the session stays where it is.
  const world = await instrumentWorld({
    rewriteCandidate(input) {
      Object.assign(input.checkpoint, { version: SESSION_CHECKPOINT_VERSION + 1 });
      return input;
    },
  });
  try {
    await stream.nextTurn();
    await waitForParkedTurnStep(anchor.runId);
    await workflowRuntime.dispatchSession({
      command: handoffFollowUp("dpl_b", "Alice asks for a checkpoint.", "capture"),
      sessionId: anchor.runId,
    });
    await stream.nextTurn();
    const [captured] = world.candidates.values();
    assert(captured !== undefined);
    return captured;
  } finally {
    world.restore();
    stream.dispose();
    await anchor.cancel();
  }
}

function rebindCheckpoint(
  checkpoint: HandoffWorkflowEntryInput["checkpoint"],
  sessionId: string,
  continuationToken: string,
): HandoffWorkflowEntryInput["checkpoint"] {
  const { serializedContext, sessionState } = checkpoint;
  return {
    ...checkpoint,
    serializedContext: { ...serializedContext, "eve.continuationToken": continuationToken },
    sessionState: {
      ...sessionState,
      continuationToken,
      sessionId,
      snapshot: {
        session: { ...sessionState.snapshot.session, continuationToken, sessionId },
      },
    },
  };
}

async function openSession(
  options: { readonly continuationToken?: string; readonly idempotencyKey?: string } = {},
) {
  const anchor = await startSessionOwner(workflowEntry, [
    {
      kind: "initial",
      idempotencyKey: options.idempotencyKey,
      ownerDeploymentId: "dpl_a",
      sessionTimeoutMs: false,
      input: { message: "Alice opens a research session." },
      serializedContext: buildSerializedContext({
        acceptedDeploymentId: "dpl_a",
        channelKind: "http",
        continuationToken: options.continuationToken,
      }),
    },
  ]);
  return {
    anchor,
    stream: captureTurnEvents(anchor),
    workflowRuntime: createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    }),
  };
}

function stableInbox(sessionId: string): string {
  return sessionInboxHookToken(sessionCommandHookToken(sessionId));
}

function aliceSends(message: string) {
  return { kind: "send" as const, payload: { message }, turnPolicy: "queue" as const };
}

function isCandidateCreated(event: AnyEventRequest): boolean {
  return (
    event.eventType === "run_created" &&
    (event as RunCreatedEventRequest).eventData.deploymentId === "dpl_b"
  );
}

/**
 * Observes every event before it is written (batching off, so none bypass it)
 * and captures, and optionally rewrites, each candidate started on `dpl_b`.
 */
async function instrumentWorld(options: {
  readonly beforeEvent?: (runId: string, event: AnyEventRequest) => Promise<void> | void;
  /** Fails each candidate's start after its run is created, before it is queued. */
  readonly failCandidateStart?: boolean;
  readonly rewriteCandidate?: (input: HandoffWorkflowEntryInput) => unknown;
}) {
  const world = await getWorld();
  const candidates = new Map<string, HandoffWorkflowEntryInput>();
  const encoded = new Map<string, Promise<unknown>>();
  const rewrite = (runId: string, input: unknown): Promise<unknown> => {
    let pending = encoded.get(runId);
    if (pending === undefined) {
      pending = (async () => {
        const args = (await hydrateWorkflowArguments(input, runId, undefined)) as [
          HandoffWorkflowEntryInput,
        ];
        candidates.set(runId, structuredClone({ ...args[0], sessionWritable: undefined }) as never);
        if (options.rewriteCandidate === undefined) return input;
        const rewritten = [options.rewriteCandidate(args[0])];
        const operations: Promise<void>[] = [];
        const result = await dehydrateWorkflowArguments(rewritten, runId, undefined, operations);
        await Promise.all(operations);
        return result;
      })();
      encoded.set(runId, pending);
    }
    return pending;
  };
  const createBatch = world.events.createBatch;
  world.events.createBatch = undefined;
  const createEvent = world.events.create.bind(world.events);
  const created = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
    const [runId] = args;
    const event = args[1] as AnyEventRequest;
    await options.beforeEvent?.(runId, event);
    if (isCandidateCreated(event)) {
      const data = (event as RunCreatedEventRequest).eventData;
      data.input = await rewrite(runId, data.input);
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
      if (options.failCandidateStart === true)
        throw Object.assign(new Error("The queue is unavailable."), { name: "FatalError" });
      message.runInput.input = await rewrite(message.runId, message.runInput.input);
    }
    return queue(...args);
  });
  return {
    candidates,
    async events(runId: string) {
      const listed = await world.events.list({
        pagination: { limit: 1000 },
        resolveData: "none",
        runId,
      });
      return listed.data;
    },
    restore() {
      created.mockRestore();
      queued.mockRestore();
      world.events.createBatch = createBatch;
    },
  };
}

async function listSessionHookTokens(runId: string): Promise<string[]> {
  const hooks = await (await getWorld()).hooks.list({ runId });
  return hooks.data.map((hook) => hook.token).filter(isSessionInboxHookToken);
}

async function countSessionHookClaims(runId: string): Promise<number> {
  const events = await (
    await getWorld()
  ).events.list({
    pagination: { limit: 1000 },
    resolveData: "all",
    runId,
  });
  return events.data.filter(
    (event) => event.eventType === "hook_created" && isSessionInboxHookToken(event.eventData.token),
  ).length;
}

/** The user messages of a run's longest saved history, once it contains every one of `messages`. */
async function waitForUserMessages(runId: string, ...messages: string[]): Promise<string[]> {
  let saved: string[] = [];
  await vi.waitFor(
    async () => {
      // Recorded steps are not returned in turn order; the settled history is
      // the one that accumulated every turn.
      saved = (await readTurnStepStates(runId))
        .map((state) =>
          state.history
            .filter((entry) => entry.role === "user")
            .map((entry) => JSON.stringify(entry.content)),
        )
        .reduce((longest, history) => (history.length > longest.length ? history : longest), []);
      for (const message of messages)
        expect(
          saved.some((entry) => entry.includes(message)),
          message,
        ).toBe(true);
    },
    { timeout: 10_000 },
  );
  return saved;
}

function positionOf(messages: readonly string[], message: string): number {
  return messages.findIndex((entry) => entry.includes(message));
}

function countOf(messages: readonly string[], message: string): number {
  return messages.filter((entry) => entry.includes(message)).length;
}

/** Waits until a run other than `previousOwnerRunId` owns the session's stable inbox. */
async function waitForNewOwner(sessionId: string, previousOwnerRunId: string) {
  let owner: Awaited<ReturnType<typeof waitForCommandHookOwner>> | undefined;
  await vi.waitFor(
    async () => {
      owner = await waitForCommandHookOwner(stableInbox(sessionId));
      expect(owner.runId).not.toBe(previousOwnerRunId);
    },
    { timeout: 10_000 },
  );
  return owner!;
}

/** The idle session's lifecycle as an eve 0.66 owner kept it: an emission position. */
function eve066LifecycleState(state: Record<string, unknown> | undefined) {
  const projection = storedProjection(state);
  const {
    [SESSION_PROJECTION_STATE_KEY]: _projection,
    "eve.harness.turnState": _turnState,
    ...rest
  } = state ?? {};
  return {
    ...rest,
    "eve.harness.emission": {
      sequence: projection.nextSequence,
      sessionStarted: projection.started === true,
      stepIndex: 0,
      turnId: "",
    },
  };
}

/** The checkpoint an eve 0.66 owner wrote (checkpoint version 8). */
function toEve066Checkpoint(input: HandoffWorkflowEntryInput): unknown {
  const { checkpoint, ...fields } = input;
  const { history, serializedContext, sessionState, ...checkpointFields } = checkpoint;
  const { "eve.stateLayout": _stateLayout, ...context } = serializedContext;
  return {
    ...fields,
    checkpoint: {
      ...checkpointFields,
      mode: "conversation",
      serializedContext: {
        ...context,
        "eve.mode": "conversation",
        "eve.runtime.taskDeliveryPolicy": "auto",
        "eve.turnTaskDelivery": "none",
      },
      sessionState: {
        ...sessionState,
        snapshot: {
          session: {
            ...sessionState.snapshot.session,
            history,
            state: {
              ...eve066LifecycleState(sessionState.snapshot.session.state),
              // A finished subagent the old owner kept resumable; its run no longer exists.
              "eve.agent.handles": {
                handles: [
                  {
                    address: {
                      continuationToken: "child-token",
                      kind: "agent/local",
                      sessionId: "wrun_child_from_eve_066",
                    },
                    phase: "parked",
                  },
                ],
              },
            },
          },
        },
        version: 1,
      },
      version: 8,
    },
  };
}
