import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createSession } from "#channel/session.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import {
  finalizeInstrumentationProviders,
  registerInstrumentationProvider,
} from "#instrumentation/providers.js";
import {
  textStreamResult,
  toolCallsStreamResult,
  toolCallStreamResult,
} from "#internal/testing/approval-resume.js";
import { captureConsoleOutput, captureLogRecords } from "#internal/testing/log-records.js";
import {
  deployServiceBody,
  deployServiceWorkflow,
  napWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { defineMemory } from "#public/memory/index.js";
import { isHookNotFound } from "#shared/run-errors.js";

import type { StoredWait } from "#internal/testing/workflow-test-world.js";

import type {
  CompletingStep,
  HostCapabilities,
  HostSetup,
  HostUnderTest,
  SessionHostKind,
} from "./host-under-test.js";
import {
  alice,
  expectEachFactOnce,
  ofType,
  probe,
  recorded,
  violations,
  turnFrom,
  type Probe,
  type ProbeOptions,
} from "./probe.js";

// The host battery: what every session host guarantees, as tests. `describeSessionHost` runs them
// against the host `make` returns; a host without a capability skips the cases that need it, and
// says so. Port-level cases drive the host's addresses, streams and commands; session-level cases
// run a probe agent with a scripted model through the faults a host can suffer.

vi.setConfig({ testTimeout: 60_000 });

/** A case: a probe agent, a host for it, and what to check. */
interface CaseOptions extends ProbeOptions {
  readonly setup?: HostSetup;
}

export function describeSessionHost(name: string, kind: SessionHostKind): void {
  /** Runs `body` against a fresh host for the probe agent `options` describe. */
  const withHost = async (
    options: CaseOptions,
    body: (host: HostUnderTest, probe: Probe) => Promise<void>,
  ): Promise<Probe> => {
    const agent = await probe(options);
    await agent.test.run(async () => {
      const host = await kind.make(options.setup);
      try {
        await body(host, agent);
      } finally {
        await host.dispose();
      }
    });
    return agent;
  };

  /** A case that runs only on hosts with `capability`; others report it skipped. */
  const needs = (capability: keyof HostCapabilities, title: string, test: () => Promise<void>) =>
    it.skipIf(!kind.capabilities[capability])(`${title} [${capability}]`, test);
  /**
   * A case a host with `capability` is known to fail, with the symptom it shows. `test` asserts
   * the broken state itself, so it fails once the bug is fixed, and the fix turns it into a case.
   */
  const brokenOn = (
    capability: keyof HostCapabilities,
    title: string,
    symptom: string,
    test: () => Promise<void>,
  ) =>
    it.skipIf(!kind.capabilities[capability])(`${title} [${capability}; broken: ${symptom}]`, test);

  describe(`session host: ${name}`, () => {
    describe("ports", () => {
      it("delivers a message to its session, and keeps the stream in order to its tail", async () => {
        await withHost(
          { name: `${name}-delivery`, respond: () => textStreamResult("Noted, Alice.") },
          async ({ runtime, settled }) => {
            const first = await (
              await alice(runtime, `${name}:delivery`).send("Alice asks.", { auth: null })
            ).result();
            const second = await (
              await alice(runtime, `${name}:delivery`).send("Alice asks again.", { auth: null })
            ).result();
            expect([first.status, second.status]).toEqual(["completed", "completed"]);
            expect(second.sessionId).toBe(first.sessionId);
            await settled();
            const events = await recorded(runtime, first.sessionId);
            const lines = [...new Set(events.map(({ meta }) => meta.position.line))];
            expect(lines).toEqual(lines.map((_, index) => index));
            expect(await runtime.getStreamTailIndex(first.sessionId)).toBe(lines.at(-1));
            // A negative start reads back from the tail.
            const tail = await (
              await runtime.getEventStream(first.sessionId, { follow: false, startIndex: -1 })
            )
              .getReader()
              .read();
            expect(tail.value?.meta.position.line).toBe(lines.at(-1));
            expect(await violations(runtime, first.sessionId)).toEqual([]);
          },
        );
      });

      it("answers a command to a session it never ran as inactive", async () => {
        await withHost(
          { name: `${name}-unknown`, respond: () => textStreamResult("") },
          async ({ runtime }) => {
            await expect(
              runtime.dispatchSession({
                command: { deliveryId: "cancel-unknown", kind: "cancel" },
                sessionId: "session_unknown",
              }),
            ).resolves.toEqual({ status: "no_active_turn" });
          },
        );
      });

      it("refuses a delivery to a hook nothing holds, and to the address of a session that ended", async () => {
        await withHost(
          { name: `${name}-gone`, respond: () => textStreamResult("Noted.") },
          async ({ runtime, settled }) => {
            const refusal = (token: string) =>
              resumeRoutedHook(token, { kind: "cancel", auth: null, deliveryId: "late" }).then(
                () => undefined,
                (error: unknown) => (isHookNotFound(error) ? "not found" : error),
              );
            expect(await refusal(`eve:battery:${name}:nobody`)).toBe("not found");
            const first = await (
              await alice(runtime, `${name}:gone`).send("Alice asks.", { auth: null })
            ).result();
            await runtime.dispatchSession({
              command: { deliveryId: "end", kind: "reset" },
              sessionId: first.sessionId,
            });
            await settled();
            expect(await refusal(sessionInboxHookToken(`${name}:gone`))).toBe("not found");
          },
        );
      });

      it("runs the agent tool's child session and hears its reply", async () => {
        const firstMessage = (prompt: string) =>
          JSON.stringify(
            (JSON.parse(prompt) as { role: string; content: unknown }[]).find(
              (message) => message.role === "user",
            )?.content ?? "",
          );
        await withHost(
          {
            name: `${name}-child`,
            respond: (prompt) =>
              // The child the agent tool opens answers; its parent hears it.
              firstMessage(prompt).includes("Summarize Bob's notes.")
                ? textStreamResult("Bob's notes say ship on Friday.")
                : prompt.includes('"role":"tool"')
                  ? textStreamResult("Alice, the helper is on it.")
                  : toolCallsStreamResult([
                      {
                        input: JSON.stringify({ message: "Summarize Bob's notes." }),
                        toolCallId: "call-agent",
                        toolName: "agent",
                      },
                    ]),
          },
          async ({ runtime, settled }) => {
            const result = await (
              await alice(runtime, `${name}:child`).send("Ask a helper.", { auth: null })
            ).result();
            expect(result).toMatchObject({
              reply: "Alice, the helper is on it.",
              status: "completed",
            });
            await settled();
            const events = await recorded(runtime, result.sessionId);
            const settledCalls = ofType(events, "call.settled");
            expect(settledCalls).toHaveLength(1);
            // The child session ran: its reply is the call's output the parent read.
            expect(settledCalls[0]).toMatchObject({ data: { outcome: "completed" } });
            expect(JSON.stringify(settledCalls[0])).toContain("Bob's notes say ship on Friday.");
            expect(await violations(runtime, result.sessionId)).toEqual([]);
          },
        );
      });
    });

    describe("sessions", () => {
      const lookup = { name: "lookup" };
      const isTurnStep = (step: { readonly name: string }) => step.name.includes("turnStep");

      needs(
        "retries",
        "runs a tool once when its step loses its completion, and the retry knows it ran",
        async () => {
          let completions = 0;
          const { prompts, ran } = await withHost(
            {
              name: `${name}-lost-completion`,
              respond: (prompt) =>
                prompt.includes("result was lost")
                  ? textStreamResult("Done.")
                  : toolCallStreamResult({
                      input: "{}",
                      toolCallId: "lookup-1",
                      toolName: "lookup",
                    }),
              setup: {
                faults: { loseCompletion: (step) => isTurnStep(step) && ++completions === 1 },
              },
              tools: [lookup],
            },
            async ({ runtime, settled }) => {
              const result = await (
                await alice(runtime, `${name}:lost`).send("Look it up.", { auth: null })
              ).result();
              expect(result.status).toBe("completed");
              await settled();
              const events = await recorded(runtime, result.sessionId);
              expectEachFactOnce(events);
              expect(ofType(events, "turn.settled")).toMatchObject([
                { data: { outcome: "completed" } },
              ]);
            },
          );
          expect(ran).toEqual(["lookup"]);
          expect(prompts[1]).toContain("This call completed, but its result was lost");
        },
      );

      needs(
        "retries",
        "fails the turn, not the session, once a step runs out of retries",
        async () => {
          let completions = 0;
          const { prompts, ran } = await withHost(
            {
              name: `${name}-retry-limit`,
              respond: (prompt, call) =>
                prompt.includes("Try again")
                  ? textStreamResult("Done.")
                  : toolCallStreamResult({
                      input: "{}",
                      toolCallId: `lookup-${call}`,
                      toolName: "lookup",
                    }),
              // Every attempt of the first step loses its completion; the step that fails the turn
              // keeps its own.
              setup: {
                faults: { loseCompletion: (step) => isTurnStep(step) && ++completions <= 4 },
              },
              tools: [lookup],
            },
            async ({ runtime, settled }) => {
              const address = alice(runtime, `${name}:limit`);
              const failed = await (await address.send("Look it up.", { auth: null })).result();
              const next = await (
                await address.send("Try again, please.", { auth: null })
              ).result();
              expect(next.sessionId).toBe(failed.sessionId);
              await settled();
              const events = await recorded(runtime, failed.sessionId);
              expectEachFactOnce(events);
              expect(ofType(events, "turn.settled")).toMatchObject([
                { data: { error: { code: "TURN_FAILED" }, outcome: "failed" } },
                { data: { outcome: "completed" } },
              ]);
              expect(ofType(events, "session.ended")).toEqual([]);
            },
          );
          // The first retry knew it was one: it read what its attempt did.
          expect(prompts[1]).toContain("This call completed, but its result was lost");
          // The first attempt and three retries ran; the attempt past the limit didn't.
          expect(ran).toEqual(["lookup", "lookup", "lookup", "lookup"]);
        },
      );

      needs(
        "retries",
        "fails the turn with a fixed error when every attempt's write fails, and runs the next",
        async () => {
          // A failed attempt waits this long for its stream's writes before it retries.
          vi.stubEnv("WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS", "500");
          onTestFinished(() => {
            vi.unstubAllEnvs();
          });
          await withHost(
            {
              name: `${name}-write-failures`,
              respond: (_prompt, call) =>
                call === 1
                  ? toolCallStreamResult({ input: "{}", toolCallId: "lookup", toolName: "lookup" })
                  : textStreamResult("Done."),
              // Every attempt of the first step fails to write; the recovery step's write succeeds.
              setup: { faults: { failFirstWrites: 4 } },
              tools: [lookup],
            },
            async ({ failedWrites, runtime, settled }) => {
              const address = alice(runtime, `${name}:writes`);
              const failed = await (await address.send("Look it up.", { auth: null })).result();
              await (await address.send("Try again, please.", { auth: null })).result();
              await settled();
              const events = await recorded(runtime, failed.sessionId);
              // The turn reports a fixed failure, under an id its log line carries, not what the
              // last attempt threw.
              expect(ofType(events, "turn.settled")).toMatchObject([
                {
                  data: {
                    error: {
                      code: "TURN_FAILED",
                      id: expect.any(String),
                      message:
                        "This turn failed before it finished. Send another message to continue.",
                    },
                    outcome: "failed",
                  },
                },
                { data: { outcome: "completed" } },
              ]);
              expect(JSON.stringify(events)).not.toContain("The session stream is unavailable");
              expect(failedWrites()).toBe(4);
            },
          );
        },
      );

      needs(
        "retries",
        kind.dispatchStep === undefined
          ? "starts a task's run once when the turn step after its start is retried"
          : "starts a task's run once when the step that reports it started is retried",
        async () => {
          let reported = 0;
          // The run whose step lost its completion.
          let lostIn: string | undefined;
          // The first dispatch step commits the task's start, and its hook may run after the step
          // completes, so the fault keys on the step, armed from the start, not on the hook. In
          // process, where dispatch is no step of its own, it is the turn step after the hook ran.
          const { dispatchStep } = kind;
          const loses = (step: CompletingStep) =>
            dispatchStep === undefined
              ? reported > 0 && step.name.includes("turnStep")
              : step.name.includes(dispatchStep);
          await withHost(
            {
              name: `${name}-task-retry`,
              events: {
                "task.started"() {
                  reported += 1;
                },
              },
              respond: (prompt) =>
                prompt.includes('"role":"tool"')
                  ? textStreamResult("Started the deploy.")
                  : toolCallStreamResult({
                      input: JSON.stringify({ service: "api" }),
                      toolCallId: "deploy",
                      toolName: "deploy_service",
                    }),
              // That step loses its completion once.
              setup: {
                faults: {
                  loseCompletion: (step) => {
                    if (lostIn !== undefined || !loses(step)) return false;
                    lostIn = step.runId;
                    return true;
                  },
                },
                workflows: [deployServiceBody()],
              },
              tools: [{ name: "deploy_service", task: true, workflow: deployServiceWorkflow }],
            },
            async ({ runtime, settled, workflowRunsStarted }) => {
              const before = await workflowRunsStarted();
              const sent = await alice(runtime, `${name}:task`).send("Deploy the api.", {
                auth: null,
              });
              const result = await sent.result();
              await settled();
              expect(
                lostIn,
                `No ${dispatchStep ?? "turnStep"} completed after the task started, so none was retried.`,
              ).toBe(sent.sessionId);
              expect(reported).toBe(1);
              const events = await recorded(runtime, result.sessionId);
              expect(ofType(events, "task.ended").map((event) => event.data.outcome)).toEqual([
                "completed",
              ]);
              expect((await workflowRunsStarted()) - before).toBe(1);
            },
          );
        },
      );

      for (const spec of ["8", "9"]) {
        needs(
          "durable",
          `finishes a turn whose model call was running when the process died (spec ${spec})`,
          async () => {
            // Spec 8 runs stamp inline steps with their owner; a restart must release them instead
            // of waiting out the owner's lease.
            let started!: () => void;
            const modelCallStarted = new Promise<void>((resolve) => (started = resolve));
            const { prompts } = await withHost(
              {
                name: `${name}-dead-model-call-${spec}`,
                setup: { specVersion: spec },
                respond: async (_prompt, call) => {
                  if (call > 1) return textStreamResult("Noted, Alice.");
                  // The first call never returns: its process dies while it runs.
                  started();
                  return await new Promise<never>(() => {});
                },
              },
              async ({ restart, runSpecVersion, runtime, settled }) => {
                const sent = await alice(runtime, `${name}:dead-${spec}`).send(
                  "Alice asks you to acknowledge receipt.",
                  { auth: null },
                );
                expect(await runSpecVersion!(sent.sessionId)).toBe(Number(spec));
                await modelCallStarted;
                await restart!();
                const turn = await turnFrom(runtime, sent.sessionId);
                expect(ofType(turn, "turn.settled")).toMatchObject([
                  { data: { outcome: "completed" } },
                ]);
                await settled();
                expect(ofType(await recorded(runtime, sent.sessionId), "session.ended")).toEqual(
                  [],
                );
              },
            );
            expect(prompts).toHaveLength(2);
          },
        );
      }

      const napper = (ms: number): CaseOptions => ({
        name: `${name}-nap-${ms}`,
        respond: (prompt) =>
          prompt.includes('"role":"tool"')
            ? textStreamResult("Noted, Alice.")
            : toolCallStreamResult({
                input: JSON.stringify({ ms }),
                toolCallId: "nap",
                toolName: "nap",
              }),
        tools: [{ name: "nap", workflow: napWorkflow }],
      });

      needs("durable", "arms a sleeping turn's lost timer again after a restart", async () => {
        await withHost(napper(1_000), async ({ restart, runtime, storedWaits }) => {
          const sent = await alice(runtime, `${name}:nap`).send("Alice asks you to nap.", {
            auth: null,
          });
          // The nap's wait, due soon; the session's idle timeout is due much later.
          const napOf = (waits: readonly StoredWait[]) =>
            waits.find((wait) => Date.parse(wait.resumeAt!) - Date.parse(wait.createdAt) < 60_000);
          await vi.waitFor(
            async () => {
              expect(napOf(await storedWaits!())).toBeDefined();
            },
            { interval: 20, timeout: 10_000 },
          );
          // The timer was still pending when the process died, so the restart must arm it.
          expect((await storedWaits!()).map((wait) => wait.status)).not.toContain("completed");
          const resumeAt = Date.parse(napOf(await storedWaits!())!.resumeAt!);
          await restart!();
          const turn = await turnFrom(runtime, sent.sessionId);
          expect(ofType(turn, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
          // It waited out the nap: the turn didn't finish before its timer was due.
          expect(Date.now()).toBeGreaterThanOrEqual(resumeAt);
        });
      });

      brokenOn(
        "durable",
        "finishes a turn whose process died between storing a wait and journaling it",
        "its replay's wait_created conflicts with the stored wait and is dropped, so nothing wakes the run",
        async () => {
          await withHost(
            napper(200),
            async ({
              crashBeforeNextWaitEvent,
              restart,
              runStatus,
              runtime,
              settled,
              storedWaits,
            }) => {
              const crashed = crashBeforeNextWaitEvent!(60_000, 10_000);
              const sent = await alice(runtime, `${name}:crash`).send("Alice asks you to nap.", {
                auth: null,
              });
              const crash = await crashed;
              // Past the nap's due time, a World that recovered it is delivering its wake-up.
              const due = Date.now() + 500;
              await restart!();
              await new Promise((resolve) => setTimeout(resolve, due - Date.now()));
              await settled();
              // world-local bug: it stores a wait's claim and the wait before its `wait_created`
              // event, so the replay's `wait_created` hits the claim, fails with
              // `EntityConflictError` and is dropped. No event, no timer: the run stays parked.
              const waits = await storedWaits!();
              expect(waits.find((wait) => wait.waitId === crash.waitId)?.status).toBe("waiting");
              expect(await runStatus!(crash.runId)).toBe("running");
              expect(ofType(await recorded(runtime, sent.sessionId), "turn.settled")).toEqual([]);
            },
          );
        },
      );

      needs(
        "stamps",
        "parks a run another eve version owns at a restart, and resets it on its thread's next message",
        async () => {
          const logs = captureLogRecords();
          const output = captureConsoleOutput();
          await withHost(
            { name: `${name}-stranded`, respond: () => textStreamResult("Noted.") },
            async ({ restart, rewriteRunAttributes, runStatus, runtime, settled }) => {
              const thread = alice(runtime, `${name}:stranded`);
              const first = await (
                await thread.send("Alice opens the thread.", { auth: null })
              ).result();
              await settled();
              const tail = await runtime.getStreamTailIndex(first.sessionId);
              // As after the first upgrade from a release that didn't stamp its owners.
              await restart!({
                beforeStart: () =>
                  rewriteRunAttributes!(first.sessionId, { [EVE_VERSION_ATTRIBUTE]: undefined }),
              });
              await settled();
              // The restart's replay of the run was skipped: it wrote nothing, and still runs.
              const messages = () => logs.records.map((record) => record.message).join("\n");
              expect(messages()).toContain(
                `Skipping replay of stranded session run "${first.sessionId}"`,
              );
              expect(await runtime.getStreamTailIndex(first.sessionId)).toBe(tail);
              expect(await runStatus!(first.sessionId)).toBe("running");

              const byId = await createSession(first.sessionId, runtime)
                .send("Bob follows up on the old session.", { auth: null })
                .then(
                  () => undefined,
                  (error: unknown) => error,
                );
              expect(SessionStrandedError.is(byId)).toBe(true);
              expect((byId as SessionStrandedError).owner.eveVersion).toBeUndefined();

              const next = await (
                await thread.send("Alice continues the thread.", { auth: null })
              ).result();
              expect(next.sessionId).not.toBe(first.sessionId);
              expect(next.status).toBe("completed");
              await settled();
              expect(await runStatus!(first.sessionId)).toBe("cancelled");
              expect(messages()).toContain("Reset stranded session");
              expect(JSON.stringify(logs.records) + output.lines.join("\n")).not.toContain(
                "CORRUPTED_EVENT_LOG",
              );
            },
          );
        },
      );

      needs(
        "externalCancel",
        "answers a request whose session's run was cancelled outside eve without running it",
        async () => {
          const { ran } = await withHost(
            {
              name: `${name}-external-cancel`,
              respond: (prompt) =>
                prompt.includes('"role":"tool"')
                  ? textStreamResult("Done.")
                  : toolCallStreamResult({ input: "{}", toolCallId: "deploy", toolName: "deploy" }),
              tools: [{ approval: true, name: "deploy" }],
            },
            async ({ cancelRunOutsideEve, runtime, settled }) => {
              const address = alice(runtime, `${name}:external`);
              const asked = await (await address.send("Deploy, please.", { auth: null })).result();
              expect(asked.interactions).toHaveLength(1);
              await settled();
              await cancelRunOutsideEve!(asked.sessionId);
              await settled();
              const answered = await address
                .deliver(
                  {
                    answers: [
                      { interactionId: asked.interactions[0]!.interactionId, optionId: "approve" },
                    ],
                  },
                  { auth: null },
                )
                .then(
                  (delivery) => delivery.sessionId,
                  (error: unknown) => error,
                );
              await settled();
              // The answer never reaches the cancelled session.
              expect(answered).not.toBe(asked.sessionId);
            },
          );
          expect(ran).toEqual([]);
        },
      );

      needs(
        "moves",
        "attributes a failure to the running turn after a compaction hands the session to a new owner",
        async () => {
          const agentName = `${name}-failed-after-move`;
          const failedTurnIds: (string | undefined)[] = [];
          await registerInstrumentationProvider({
            agentName,
            slot: "capture",
            value: defineInstrumentation({
              events: {
                "turn.settled": (event) => {
                  if (event.outcome === "failed") failedTurnIds.push(event.turnId);
                },
              },
            }),
          });
          finalizeInstrumentationProviders({ serviceName: agentName });
          onTestFinished(() => {
            delete (globalThis as Record<symbol, unknown>)[
              Symbol.for("eve.harness-instrumentation-providers")
            ];
            delete (globalThis as Record<symbol, unknown>)[
              Symbol.for("eve.instrumentation-runtime")
            ];
          });
          await withHost(
            {
              modules: [
                {
                  loadNamespace: async () => ({
                    default: defineMemory({
                      provider: {
                        recall: {
                          // The second turn's recall fails that turn; an abort-shaped error isn't
                          // retried.
                          "turn.started": async (context) => {
                            if (context.turn.sequence === 0) return null;
                            throw Object.assign(new Error("This operation was aborted"), {
                              name: "AbortError",
                            });
                          },
                        },
                      },
                      scope: "test",
                    }),
                  }),
                  logicalPath: "memory/failing-recall.ts",
                },
              ],
              name: agentName,
              respond: () => textStreamResult("Noted."),
            },
            async ({ runtime, settled }) => {
              const address = alice(runtime, `${name}:moved`);
              const first = await (
                await address.send("Alice asks for the summary.", { auth: null })
              ).result();
              await createSession(first.sessionId, runtime).compact();
              await settled();
              // The session kept its address across the move.
              const failed = await (await address.send("Bob asks again.", { auth: null })).result();
              expect(failed.sessionId).toBe(first.sessionId);
              await settled();
              const events = await recorded(runtime, first.sessionId);
              expect(ofType(events, "context.settled")).toMatchObject([
                { data: { kind: "compaction", outcome: "completed" } },
              ]);
              // A value that fails fails its turn, not the session.
              expect(
                ofType(events, "turn.settled").map(({ data }) => [data.turnId, data.outcome]),
              ).toEqual([
                ["turn_0", "completed"],
                ["turn_1", "failed"],
              ]);
              expect(ofType(events, "session.ended")).toEqual([]);
            },
          );
          expect(failedTurnIds).toEqual(["turn_1"]);
        },
      );
    });
  });
}
