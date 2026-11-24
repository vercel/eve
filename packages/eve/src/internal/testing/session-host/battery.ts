import { builtInHosts } from "#runtime/app.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { startsNewAddress } from "#channel/channel-address.js";
import { createSession } from "#channel/session.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { DEFAULT_TURN_POLICY } from "#channel/types.js";
import { sessionAddress } from "#execution/durable.js";
import { identifyCommand } from "#execution/session-commands.js";
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

import type { StoredWait } from "#internal/testing/local-world-database.js";

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

vi.setConfig({ testTimeout: 60_000 });

interface CaseOptions extends ProbeOptions {
  readonly setup?: HostSetup;
}

export function describeSessionHost(name: string, kind: SessionHostKind): void {
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

  const needs = (capability: keyof HostCapabilities, title: string, test: () => Promise<void>) =>
    it.skipIf(!kind.capabilities[capability])(`${title} [${capability}]`, test);

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

      it("delivers a send marked as opening a new address to the session already holding it", async () => {
        await withHost(
          { name: `${name}-new-address`, respond: () => textStreamResult("Noted, Alice.") },
          async ({ runtime, settled }) => {
            const address = alice(runtime, `${name}:new-address`);
            const first = await (
              await address.send("Alice asks.", { auth: null, [startsNewAddress]: true })
            ).result();
            const second = await (
              await address.send("Alice asks again.", { auth: null, [startsNewAddress]: true })
            ).result();
            expect([first.status, second.status]).toEqual(["completed", "completed"]);
            expect(second.sessionId).toBe(first.sessionId);
            await settled();
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
              resumeRoutedHook(builtInHosts(), token, {
                kind: "cancel",
                auth: null,
                deliveryId: "late",
              }).then(
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

      it("reads its stream lines, tail and status through Durable", async () => {
        await withHost(
          { name: `${name}-durable-reads`, respond: () => textStreamResult("Noted, Alice.") },
          async ({ durable, runtime, settled }) => {
            const first = await (
              await alice(runtime, `${name}:durable-reads`).send("Alice asks.", { auth: null })
            ).result();
            await settled();
            const tail = await durable.tail(first.sessionId);
            expect(tail).toBe(await runtime.getStreamTailIndex(first.sessionId));
            const lines: { position: number; record: unknown }[] = [];
            for await (const { line, position } of durable.readStream(first.sessionId, 1)) {
              lines.push({ position, record: JSON.parse(line) });
              if (position === tail) break;
            }
            const records: unknown[] = [];
            for await (const record of await runtime.getLineStream(first.sessionId, {
              follow: false,
            }))
              records.push(record);
            expect(lines).toEqual(
              records.slice(1).map((record, index) => ({ position: index + 1, record })),
            );
            expect(["running", "parked"]).toContain(await durable.status(first.sessionId));
            await runtime.dispatchSession({
              command: { deliveryId: "end", kind: "reset" },
              sessionId: first.sessionId,
            });
            await settled();
            expect(await durable.status(first.sessionId)).toBe("ended");
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

      it("stops a turn that runs when a cancel arrives, and serves the next message", async () => {
        let started!: () => void;
        const modelCallStarted = new Promise<void>((resolve) => (started = resolve));
        await withHost(
          {
            name: `${name}-interrupt`,
            respond: async (_prompt, call, signal) => {
              if (call > 1) return textStreamResult("Here is the summary, Alice.");
              started();
              await new Promise<void>((resolve) =>
                signal?.addEventListener("abort", () => resolve()),
              );
              throw signal?.reason;
            },
          },
          async ({ runtime, settled }) => {
            const thread = alice(runtime, `${name}:interrupt`);
            const asked = await thread.send("Alice asks for the long report.", { auth: null });
            await modelCallStarted;
            await createSession(asked.sessionId, runtime).cancel({ auth: null });
            const next = await (
              await thread.send("Alice asks for a summary instead.", { auth: null })
            ).result();
            expect(next).toMatchObject({
              reply: "Here is the summary, Alice.",
              sessionId: asked.sessionId,
              status: "completed",
            });
            await settled();
            const events = await recorded(runtime, asked.sessionId);
            expect(ofType(events, "turn.settled").map(({ data }) => data.outcome)).toEqual([
              "cancelled",
              "completed",
            ]);
            expect(await violations(runtime, asked.sessionId)).toEqual([]);
          },
        );
      });

      needs(
        "deliveryKeys",
        "keeps one item for a delivery key it already holds, whatever the second payload",
        async () => {
          const { prompts } = await withHost(
            { name: `${name}-held-key`, respond: () => textStreamResult("Noted, Alice.") },
            async ({ durable, runtime, settled }) => {
              const first = await (
                await alice(runtime, `${name}:held-key`).send("Alice opens her notes.", {
                  auth: null,
                })
              ).result();
              await settled();
              const send = (message: string) =>
                durable.deliver(
                  sessionAddress({ sessionId: first.sessionId }),
                  identifyCommand({
                    auth: null,
                    kind: "send",
                    payload: { message },
                    turnPolicy: DEFAULT_TURN_POLICY,
                  }),
                  { key: `${name}:held-key:reminder` },
                );
              await send("Alice adds a reminder.");
              await send("Bob adds a different reminder.");
              await settled();
            },
          );
          expect(prompts).toHaveLength(2);
          expect(prompts.join("")).not.toContain("Bob adds a different reminder.");
        },
      );

      it("runs one turn for two deliveries with the same key", async () => {
        const { prompts } = await withHost(
          { name: `${name}-same-key`, respond: () => textStreamResult("Noted, Alice.") },
          async ({ durable, runtime, settled }) => {
            const first = await (
              await alice(runtime, `${name}:same-key`).send("Alice opens her notes.", {
                auth: null,
              })
            ).result();
            await settled();
            const key = `${name}:same-key:reminder`;
            const reminder = identifyCommand({
              auth: null,
              idempotencyKey: key,
              kind: "send",
              payload: { message: "Alice adds a reminder." },
              turnPolicy: DEFAULT_TURN_POLICY,
            });
            for (let delivery = 0; delivery < 2; delivery++)
              expect(
                await durable.deliver(sessionAddress({ sessionId: first.sessionId }), reminder, {
                  key,
                }),
              ).toMatchObject({ accepted: true, sessionId: first.sessionId });
            await settled();
            const events = await recorded(runtime, first.sessionId);
            expect(ofType(events, "turn.settled").map(({ data }) => data.outcome)).toEqual([
              "completed",
              "completed",
            ]);
          },
        );
        expect(prompts).toHaveLength(2);
      });

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
          expect(prompts[1]).toContain("This call completed, but its result was lost");
          expect(ran).toEqual(["lookup", "lookup", "lookup", "lookup"]);
        },
      );

      needs(
        "retries",
        "fails the turn with a fixed error when every attempt's write fails, and runs the next",
        async () => {
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
              setup: { faults: { failFirstWrites: 4 } },
              tools: [lookup],
            },
            async ({ failedWrites, runtime, settled }) => {
              const address = alice(runtime, `${name}:writes`);
              const failed = await (await address.send("Look it up.", { auth: null })).result();
              await (await address.send("Try again, please.", { auth: null })).result();
              await settled();
              const events = await recorded(runtime, failed.sessionId);
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
          let lostIn: string | undefined;
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
            let started!: () => void;
            const modelCallStarted = new Promise<void>((resolve) => (started = resolve));
            const { prompts } = await withHost(
              {
                name: `${name}-dead-model-call-${spec}`,
                setup: { specVersion: spec },
                respond: async (_prompt, call) => {
                  if (call > 1) return textStreamResult("Noted, Alice.");
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
          const napOf = (waits: readonly StoredWait[]) =>
            waits.find((wait) => Date.parse(wait.resumeAt!) - Date.parse(wait.createdAt) < 60_000);
          await vi.waitFor(
            async () => {
              expect(napOf(await storedWaits!())).toBeDefined();
            },
            { interval: 20, timeout: 10_000 },
          );
          expect((await storedWaits!()).map((wait) => wait.status)).not.toContain("completed");
          const resumeAt = Date.parse(napOf(await storedWaits!())!.resumeAt!);
          await restart!();
          const turn = await turnFrom(runtime, sent.sessionId);
          expect(ofType(turn, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
          expect(Date.now()).toBeGreaterThanOrEqual(resumeAt);
        });
      });

      const replaysAfterRestart = (
        point: string,
        capability: keyof HostCapabilities,
        options: CaseOptions,
        body: (host: HostUnderTest, restart: () => Promise<void>, agent: Probe) => Promise<void>,
      ) =>
        needs(
          capability,
          `replays a session ${point} after a restart, and continues it`,
          async () => {
            const logs = captureLogRecords();
            const output = captureConsoleOutput();
            onTestFinished(() => {
              const lines = [
                ...logs.records.map((record) => JSON.stringify(record)),
                ...output.lines,
              ];
              expect(
                lines.filter((line) => /REPLAY_DIVERGENCE|CORRUPTED_EVENT_LOG/.test(line)),
              ).toEqual([]);
            });
            await withHost(options, async (host, agent) => {
              const restart = async () => {
                await host.settled();
                await host.restart!();
              };
              await body(host, restart, agent);
              await host.settled();
            });
          },
        );

      replaysAfterRestart(
        "parked between turns",
        "restarts",
        { name: `${name}-replay-parked`, respond: () => textStreamResult("Noted, Alice.") },
        async ({ runtime }, restart, { prompts }) => {
          const thread = alice(runtime, `${name}:replay-parked`);
          const first = await (
            await thread.send("Alice opens the thread.", { auth: null })
          ).result();
          await restart();
          const next = await (
            await thread.send("Alice continues the thread.", { auth: null })
          ).result();
          expect(next).toMatchObject({ sessionId: first.sessionId, status: "completed" });
          expect(prompts.at(-1)).toContain("Alice opens the thread.");
          const events = await recorded(runtime, first.sessionId);
          expect(ofType(events, "turn.settled").map(({ data }) => data.outcome)).toEqual([
            "completed",
            "completed",
          ]);
          expect(await violations(runtime, first.sessionId)).toEqual([]);
        },
      );

      replaysAfterRestart(
        "paused on an approval",
        "restarts",
        {
          name: `${name}-replay-approval`,
          respond: (prompt) =>
            prompt.includes('"role":"tool"')
              ? textStreamResult("Deployed, Alice.")
              : toolCallStreamResult({ input: "{}", toolCallId: "deploy", toolName: "deploy" }),
          tools: [{ approval: true, name: "deploy" }],
        },
        async ({ runtime }, restart, { ran }) => {
          const thread = alice(runtime, `${name}:replay-approval`);
          const asked = await (await thread.send("Deploy, please.", { auth: null })).result();
          expect(asked.interactions).toHaveLength(1);
          await restart();
          expect(ran).toEqual([]);
          const answered = await (
            await thread.respond(
              [{ interactionId: asked.interactions[0]!.interactionId, optionId: "approve" }],
              { auth: null },
            )
          ).result();
          expect(answered).toMatchObject({
            reply: "Deployed, Alice.",
            sessionId: asked.sessionId,
            status: "completed",
          });
          expect(ran).toEqual(["deploy"]);
          expect(await violations(runtime, asked.sessionId)).toEqual([]);
        },
      );

      const idleTimeoutMs = 3_600_000;
      replaysAfterRestart(
        "waiting out its sandbox's idle window",
        "durable",
        {
          events: {
            async "turn.started"(_event, ctx) {
              await ctx.getSandbox();
            },
          },
          name: `${name}-replay-idle`,
          respond: () => textStreamResult("Noted, Alice."),
          sandboxIdle: { idleTimeoutMs },
        },
        async ({ runtime, storedWaits }, restart, { test }) => {
          const thread = alice(runtime, `${name}:replay-idle`);
          const first = await (
            await thread.send("Alice opens the notes.", { auth: null })
          ).result();
          const idleWindow = (waits: readonly StoredWait[]) =>
            waits.find(
              (wait) =>
                wait.runId === first.sessionId &&
                wait.status !== "completed" &&
                Math.abs(Date.parse(wait.resumeAt!) - Date.parse(wait.createdAt) - idleTimeoutMs) <
                  60_000,
            );
          await vi.waitFor(
            async () => {
              expect(idleWindow(await storedWaits!())).toBeDefined();
            },
            { interval: 20, timeout: 10_000 },
          );
          await restart();
          const next = await (
            await thread.send("Alice asks for a summary.", { auth: null })
          ).result();
          expect(next).toMatchObject({ sessionId: first.sessionId, status: "completed" });
          const sandbox = test.sandboxEvents
            .filter((event) => event.endsWith(`:${first.sessionId}`))
            .map((event) => event.split(":")[0]);
          expect(sandbox).toContain("start");
          expect(sandbox).not.toContain("idle");
        },
      );

      replaysAfterRestart(
        "a compaction just handed to a new owner",
        "durable",
        { name: `${name}-replay-moved`, respond: () => textStreamResult("Noted, Alice.") },
        async ({ runtime, sessionOwner }, restart) => {
          const thread = alice(runtime, `${name}:replay-moved`);
          const first = await (
            await thread.send("Alice asks for the summary.", { auth: null })
          ).result();
          await createSession(first.sessionId, runtime).compact();
          await vi.waitFor(async () => {
            expect(await sessionOwner!(first.sessionId)).not.toBe(first.sessionId);
          });
          await restart();
          const next = await (await thread.send("Bob asks again.", { auth: null })).result();
          expect(next).toMatchObject({ sessionId: first.sessionId, status: "completed" });
          const events = await recorded(runtime, first.sessionId);
          expect(ofType(events, "context.settled")).toMatchObject([
            { data: { kind: "compaction", outcome: "completed" } },
          ]);
          expect(ofType(events, "turn.settled").map(({ data }) => data.outcome)).toEqual([
            "completed",
            "completed",
          ]);
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
              await restart!({
                beforeStart: () =>
                  rewriteRunAttributes!(first.sessionId, { [EVE_VERSION_ATTRIBUTE]: undefined }),
              });
              await settled();
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
            delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.app")];
          });
          await withHost(
            {
              modules: [
                {
                  loadNamespace: async () => ({
                    default: defineMemory({
                      provider: {
                        recall: {
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
              const failed = await (await address.send("Bob asks again.", { auth: null })).result();
              expect(failed.sessionId).toBe(first.sessionId);
              await settled();
              const events = await recorded(runtime, first.sessionId);
              expect(ofType(events, "context.settled")).toMatchObject([
                { data: { kind: "compaction", outcome: "completed" } },
              ]);
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
