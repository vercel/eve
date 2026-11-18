import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineTool } from "#tools/definition.js";
import { always } from "#tools/approval/policies.js";
import { z } from "zod";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { checkSessionSandboxStep } from "#execution/session/idle-sandbox-step.js";
import { prewarmSessionStep } from "#execution/session/prewarm-step.js";
import type { HarnessSession } from "#harness/types.js";
import type { SandboxRunning } from "#sandbox/state.js";
import { applyValueDelta } from "#shared/value-delta.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { StepFaults } from "#execution/in-process/step-attempts.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { sandboxPrepareWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import {
  startTestSession,
  type TestSessionHostKind,
} from "#internal/testing/test-session-hosts.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { defineHook, type HookDefinition } from "#public/definitions/hook.js";

const checkStep = vi.hoisted(() => ({ calls: 0, rejects: false }));

vi.mock("#execution/session/idle-sandbox-step.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#execution/session/idle-sandbox-step.js")>();
  return {
    ...actual,
    checkSessionSandboxStep: async (
      input: Parameters<typeof actual.checkSessionSandboxStep>[0],
    ) => {
      checkStep.calls += 1;
      if (checkStep.rejects) throw new Error("The sandbox check step failed.");
      return await actual.checkSessionSandboxStep(input);
    },
  };
});

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.useRealTimers();
  checkStep.rejects = false;
});

type TestAppDescriptor = NonNullable<Parameters<typeof createTestRuntime>[0]>;

const SETTLE_MS = 500;

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

function scriptedAgent(script: (prompt: string, firstUser: string) => StreamResult) {
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) =>
        script(
          JSON.stringify(prompt),
          JSON.stringify(prompt.find((message) => message.role === "user")?.content ?? ""),
        ),
      modelId: "scripted",
      provider: "eve-test",
    }),
  );
  return {
    definition: defineAgent({
      model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
    }),
  };
}

function hookModule(slug: string, hook: HookDefinition) {
  return { logicalPath: `hooks/${slug}.ts`, loadNamespace: async () => ({ default: hook }) };
}

function toolModule(slug: string, tool: object) {
  return { logicalPath: `tools/${slug}.ts`, loadNamespace: async () => ({ default: tool }) };
}

function keepRunningTool(forMs: number) {
  return toolModule(
    "keep_running",
    defineTool({
      description: "Keep the sandbox running for the export.",
      execute: async (_input, ctx) => {
        await (await ctx.getSandbox()).keepRunning({ forMs, while: "true" });
        return { kept: true };
      },
      inputSchema: z.object({}).passthrough(),
    }),
  );
}

function deployTool() {
  return toolModule(
    "deploy",
    defineTool({
      approval: { request: always() },
      description: "Deploy the service.",
      execute: async () => ({ deployed: true }),
      inputSchema: z.object({}).passthrough(),
    }),
  );
}

function calls(...toolNames: readonly string[]) {
  return (prompt: string): StreamResult => {
    const next = toolNames.find((name) => !prompt.includes(`"toolName":"${name}"`));
    return next === undefined
      ? textStreamResult("Done.")
      : toolCallsStreamResult([{ input: "{}", toolCallId: `call_${next}`, toolName: next }]);
  };
}

function keepRunningOnTurns(forMs: number) {
  return hookModule(
    "keep-running",
    defineHook({
      events: {
        async "turn.started"(_event, ctx) {
          await (await ctx.getSandbox()).keepRunning({ forMs, while: "true" });
        },
      },
    }),
  );
}

function sandboxOnTurns(opens: (turn: number) => boolean = () => true) {
  let turn = 0;
  return hookModule(
    "sandbox",
    defineHook({
      events: {
        async "turn.started"(_event, ctx) {
          turn += 1;
          if (opens(turn)) await ctx.getSandbox();
        },
      },
    }),
  );
}

async function checkStepCount(
  host: TestSessionHostKind,
  runId: string,
): Promise<number | undefined> {
  if (host !== "workflow") return undefined;
  const steps = await (await getWorld()).steps.list({ runId });
  return steps.data.filter((step) => step.stepName.endsWith("//checkSessionSandboxStep")).length;
}

async function checkStepsRun(host: TestSessionHostKind, runId: string): Promise<number> {
  return (await checkStepCount(host, runId)) ?? checkStep.calls;
}

async function withSession(
  host: TestSessionHostKind,
  options: {
    readonly agent?: TestAppDescriptor["agent"];
    readonly beforeSandboxStart?: TestAppDescriptor["beforeSandboxStart"];
    readonly name: string;
    readonly input: { readonly message?: string };
    readonly modules: TestAppDescriptor["modules"];
    readonly sandboxIdle: TestAppDescriptor["sandboxIdle"];
    readonly sandboxRun?: TestAppDescriptor["sandboxRun"];
    readonly stepFaults?: StepFaults;
  },
  body: (session: {
    readonly id: string;
    events(): string[];
    nextTurn(): Promise<SessionStreamEvent[]>;
    nextUntil(matches: (event: SessionStreamEvent) => boolean): Promise<SessionStreamEvent[]>;
    send(message: string): Promise<void>;
    answer(interactionId: string): Promise<void>;
    cancel(): Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const runtime = await createTestRuntime({
    agent: { ...options.agent, name: options.name },
    beforeSandboxStart: options.beforeSandboxStart,
    modules: options.modules,
    sandboxIdle: options.sandboxIdle,
    sandboxRun: options.sandboxRun,
  });
  await runtime.run(async () => {
    const run = await startTestSession(
      host,
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        sessionTimeoutMs: false,
        input: options.input,
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind: "http" }),
          "eve.capabilities": { requestInput: true },
        },
      },
      options.stepFaults === undefined ? {} : { stepFaults: options.stepFaults },
    );
    const inbox = sessionInboxHookToken(sessionCommandHookToken(run.runId));
    const stream = captureTurnEvents(run);
    const id = run.runId;
    try {
      await body({
        cancel: () => resumeRoutedHook(inbox, { deliveryId: "cancel-turn", kind: "cancel" }),
        id,
        events: () =>
          runtime.sandboxEvents
            .filter((event) => event.endsWith(`:${id}`))
            .map((event) => event.replace(`:${id}`, "")),
        nextTurn: () => stream.nextTurn(),
        nextUntil: (matches) => stream.nextUntil(matches),
        send: async (message) => {
          const delivery = createChannelDeliveryMetadata({
            channelKind: "http",
            channelName: "test",
          });
          await vi.waitFor(() =>
            resumeRoutedHook(inbox, { auth: ALICE, delivery, kind: "send", payload: { message } }),
          );
        },
        answer: async (interactionId) => {
          await resumeRoutedHook(inbox, {
            auth: ALICE,
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            kind: "send",
            payload: { answers: [{ interactionId, optionId: "approve" }] },
          });
        },
      });
    } finally {
      stream.dispose();
      await run.cancel().catch(() => undefined);
    }
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

describe.each(["in-process", "workflow"] as const)("idle sandbox stop on the %s host", (host) => {
  it("stops the sandbox once the session goes idle, and resumes it only when a later turn uses it", async () => {
    await withSession(
      host,
      {
        input: { message: "Alice opens the project notes." },
        modules: [sandboxOnTurns()],
        name: `idle-stop-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.nextTurn();
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));

        await session.send("Alice asks for a summary of the notes.");
        await session.nextTurn();
        await vi.waitFor(() =>
          expect(session.events()).toEqual(["definition", "start", "idle", "resume", "idle"]),
        );
      },
    );
  });

  it("adds no stop when nothing opened the sandbox, and prewarming with 0 does not start it", async () => {
    await withSession(
      host,
      {
        input: {},
        modules: [],
        name: `idle-untouched-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.send("Alice asks for a short greeting.");
        await session.nextTurn();
        await settle();

        expect(session.events()).toEqual([]);
        expect(await checkStepCount(host, session.id)).toBe(host === "workflow" ? 0 : undefined);
      },
    );
  });

  it("keeps the sandbox running into a turn that a hook starts with ctx.continue()", async () => {
    let settled = 0;
    await withSession(
      host,
      {
        input: { message: "Alice starts the weekly report." },
        modules: [
          sandboxOnTurns(),
          hookModule(
            "continue",
            defineHook({
              events: {
                "turn.settled"(_event, ctx) {
                  settled += 1;
                  if (settled === 1) ctx.continue("Keep going with the report.");
                },
              },
            }),
          ),
        ],
        name: `idle-continue-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.nextTurn();
        await session.nextTurn();
        await vi.waitFor(() =>
          expect(session.events()).toEqual(["definition", "start", "resume", "idle"]),
        );
      },
    );
  });

  it("clears the marker when the stop fails, without retrying it", async () => {
    await withSession(
      host,
      {
        input: { message: "Alice opens the project notes." },
        modules: [sandboxOnTurns((turn) => turn === 1)],
        name: `idle-failed-stop-${host}`,
        sandboxIdle: {
          idleTimeoutMs: 0,
          onStop: async () => {
            throw new Error("The sandbox service is unavailable.");
          },
        },
      },
      async (session) => {
        await session.nextTurn();
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));

        await session.send("Alice asks for a short greeting.");
        await session.nextTurn();
        await settle();

        expect(session.events()).toEqual(["definition", "start", "idle"]);
        expect(await checkStepCount(host, session.id)).toBe(host === "workflow" ? 1 : undefined);
      },
    );
  });

  it("stops a sandbox that a cancelled turn opened", async () => {
    const opened = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await withSession(
      host,
      {
        input: { message: "Alice starts a long data export." },
        modules: [
          hookModule(
            "sandbox",
            defineHook({
              events: {
                async "model.started"(_event, ctx) {
                  await ctx.getSandbox();
                  opened.resolve();
                  await release.promise;
                },
              },
            }),
          ),
        ],
        name: `idle-cancelled-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await opened.promise;
        await session.cancel();
        await settle();
        release.resolve();
        const turn = await session.nextTurn();

        expect(turn).toContainEqual(
          expect.objectContaining({
            type: "turn.settled",
            data: expect.objectContaining({ outcome: "cancelled" }),
          }),
        );
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));
      },
    );
  });

  it.runIf(host === "in-process")(
    "stops a sandbox that a turn step opened before its completion was lost",
    async () => {
      let lost = false;
      await withSession(
        host,
        {
          input: { message: "Alice opens the project notes." },
          modules: [sandboxOnTurns((turn) => turn === 1)],
          name: `idle-recovered-${host}`,
          sandboxIdle: { idleTimeoutMs: 0 },
          stepFaults: {
            loseCompletion: (step) => {
              if (lost || step.name !== "turnStep") return false;
              lost = true;
              return true;
            },
          },
        },
        async (session) => {
          await session.nextTurn();

          await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));
        },
      );
    },
  );

  it("stops a prewarmed sandbox when no message arrives within the window", async () => {
    await withSession(
      host,
      {
        input: {},
        modules: [],
        name: `idle-prewarmed-${host}`,
        sandboxIdle: { idleTimeoutMs: 200 },
      },
      async (session) => {
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]), {
          timeout: 10_000,
        });
      },
    );
  });

  it("stops a prewarmed sandbox after a first message that arrived while it was starting", async () => {
    const started = Promise.withResolvers<void>();
    await withSession(
      host,
      {
        beforeSandboxStart: () => started.promise,
        input: {},
        modules: [],
        name: `idle-prewarm-race-${host}`,
        sandboxIdle: { idleTimeoutMs: 200 },
      },
      async (session) => {
        await vi.waitFor(() => expect(session.events()).toEqual(["definition"]), {
          timeout: 10_000,
        });
        await session.send("Alice asks for a short greeting.");
        await session.nextTurn();
        started.resolve();

        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]), {
          timeout: 10_000,
        });
      },
    );
  });

  it.runIf(host === "workflow")(
    "stops a sandbox that only a workflow tool run opened",
    async () => {
      await withSession(
        host,
        {
          agent: scriptedAgent((prompt) =>
            prompt.includes('"role":"tool"')
              ? textStreamResult("The service is prepared.")
              : toolCallsStreamResult([
                  {
                    input: JSON.stringify({ service: "api" }),
                    toolCallId: "call_prepare",
                    toolName: "prepare",
                  },
                ]),
          ),
          input: { message: "Alice asks to prepare the api service." },
          modules: [
            {
              logicalPath: "tools/prepare.ts",
              loadNamespace: async () => ({
                default: defineWorkflowTool({
                  description: "Prepare a service in the sandbox.",
                  execute: sandboxPrepareWorkflow,
                  inputSchema: {},
                }),
              }),
            },
          ],
          name: `idle-workflow-tool-${host}`,
          sandboxIdle: { idleTimeoutMs: 0 },
        },
        async (session) => {
          await session.nextTurn();

          await vi.waitFor(
            () => expect(session.events()).toEqual(["definition", "start", "idle"]),
            {
              timeout: 10_000,
            },
          );
        },
      );
    },
  );

  it("stops a sandbox that only a child sharing it opened, once the parent goes idle", async () => {
    await withSession(
      host,
      {
        agent: scriptedAgent((prompt, firstUser) => {
          if (firstUser.includes("CHILD:")) return textStreamResult("The report is exported.");
          if (!prompt.includes('"toolName":"agent"'))
            return toolCallsStreamResult([
              {
                input: JSON.stringify({ message: "CHILD: export the report" }),
                toolCallId: "call_agent",
                toolName: "agent",
              },
            ]);
          return textStreamResult("The report is ready.");
        }),
        input: { message: "Alice asks for the report export." },
        modules: [
          hookModule(
            "child-sandbox",
            defineHook({
              events: {
                async "turn.started"(_event, ctx) {
                  if (ctx.session.parent !== undefined) await ctx.getSandbox();
                },
              },
            }),
          ),
        ],
        name: `idle-shared-child-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.nextTurn();

        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]), {
          timeout: 10_000,
        });
      },
    );
  });

  it("starts the idle window again after a turn that arrives inside it", async () => {
    const windowMs = 2_000;
    await withSession(
      host,
      {
        input: { message: "Alice opens the project notes." },
        modules: [sandboxOnTurns((turn) => turn === 1)],
        name: `idle-window-reset-${host}`,
        sandboxIdle: { idleTimeoutMs: windowMs },
      },
      async (session) => {
        await session.nextTurn();
        await new Promise((resolve) => setTimeout(resolve, windowMs / 3));
        await session.send("Alice asks for a short greeting.");
        await session.nextTurn();
        const secondTurnEndedAt = Date.now();

        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]), {
          interval: 20,
          timeout: 10_000,
        });
        expect(Date.now() - secondTurnEndedAt).toBeGreaterThanOrEqual(windowMs - 150);
      },
    );
  });

  it.each([
    { check: "passes", exitCode: 0, stops: false },
    { check: "fails", exitCode: 1, stops: true },
  ])(
    "decides from a keepRunning() check whether to stop the idle sandbox when the check $check",
    async ({ exitCode, stops }) => {
      await withSession(
        host,
        {
          input: { message: "Alice starts the nightly export." },
          modules: [keepRunningOnTurns(60 * 60_000)],
          name: `idle-keep-running-${exitCode}-${host}`,
          sandboxIdle: { idleTimeoutMs: 0 },
          sandboxRun: () => ({ exitCode, stderr: "", stdout: "" }),
        },
        async (session) => {
          const before = await checkStepsRun(host, session.id);
          await session.nextTurn();
          await vi.waitFor(
            async () => expect(await checkStepsRun(host, session.id)).toBeGreaterThan(before),
            { timeout: 10_000 },
          );
          await settle();

          expect(session.events()).toEqual(
            stops ? ["definition", "start", "idle"] : ["definition", "start"],
          );
        },
      );
    },
  );

  it("checks a kept sandbox while a turn waits for an approval, never stops it then, and stops it once the turn ends", async () => {
    let attached = 0;
    await withSession(
      host,
      {
        agent: scriptedAgent(calls("keep_running", "deploy")),
        input: { message: "Alice asks to deploy the api service after the export." },
        modules: [keepRunningTool(5_000), deployTool()],
        name: `idle-keep-running-approval-${host}`,
        sandboxIdle: {
          idleTimeoutMs: 0,
          onAttach: async () => {
            attached += 1;
          },
        },
      },
      async (session) => {
        const asked = await session.nextUntil((event) => event.type === "interaction.opened");
        const opened = asked.at(-1);
        if (opened?.type !== "interaction.opened") throw new Error("No approval was requested.");
        await vi.waitFor(() => expect(attached).toBeGreaterThan(0), { timeout: 15_000 });
        await settle();
        expect(session.events()).toEqual(["definition", "start"]);

        await session.answer(opened.data.interactionId);
        const resumed = await session.nextUntil((event) => event.type === "turn.settled");
        expect(resumed.at(-1)).toMatchObject({ data: { outcome: "completed" } });
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));
      },
    );
  });

  it("cancels a turn that waits for an approval while a keepRunning() call is in effect", async () => {
    await withSession(
      host,
      {
        agent: scriptedAgent(calls("keep_running", "deploy")),
        input: { message: "Alice asks to deploy the api service after the export." },
        modules: [keepRunningTool(60_000), deployTool()],
        name: `idle-keep-running-cancel-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.nextUntil((event) => event.type === "interaction.opened");
        await settle();
        await session.cancel();

        const settled = await session.nextUntil((event) => event.type === "turn.settled");
        expect(settled.at(-1)).toMatchObject({ data: { outcome: "cancelled" } });
      },
    );
  });

  it("times a task wait out on time while a keepRunning() call is in effect", async () => {
    const release = Promise.withResolvers<void>();
    const timedOut = Promise.withResolvers<"timed out">();
    await withSession(
      host,
      {
        agent: scriptedAgent((prompt, firstUser) => {
          if (firstUser.includes("CHILD:")) return calls("slow_export")(prompt);
          if (prompt.includes("Stopped waiting after 2s")) timedOut.resolve("timed out");
          if (!prompt.includes('"toolName":"keep_running"')) return calls("keep_running")(prompt);
          if (!prompt.includes('"toolName":"agent"'))
            return toolCallsStreamResult([
              {
                input: JSON.stringify({ message: "CHILD: run the export" }),
                toolCallId: "call_agent",
                toolName: "agent",
              },
            ]);
          if (!prompt.includes('"toolName":"eve__task_wait"'))
            return toolCallsStreamResult([
              {
                input: JSON.stringify({ timeoutSeconds: 2 }),
                toolCallId: "call_wait",
                toolName: "eve__task_wait",
              },
            ]);
          return textStreamResult("The export is still running.");
        }),
        input: { message: "Alice starts the export and waits briefly for it." },
        modules: [
          keepRunningTool(60_000),
          toolModule(
            "slow_export",
            defineTool({
              description: "Run the export.",
              execute: async () => {
                await release.promise;
                return { exported: true };
              },
              inputSchema: z.object({}).passthrough(),
            }),
          ),
        ],
        name: `idle-keep-running-task-wait-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async () => {
        try {
          const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 20_000));

          await expect(Promise.race([timedOut.promise, late])).resolves.toBe("timed out");
        } finally {
          release.resolve();
        }
      },
    );
  });

  it("stops the idle sandbox once forMs has passed, while its check still passes", async () => {
    await withSession(
      host,
      {
        input: { message: "Alice starts a preview server." },
        modules: [keepRunningOnTurns(5_000)],
        name: `idle-keep-running-expired-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
        sandboxRun: () => ({ exitCode: 0, stderr: "", stdout: "" }),
      },
      async (session) => {
        await session.nextTurn();

        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]), {
          timeout: 15_000,
        });
      },
    );
  });

  it("keeps the sandbox running while a turn waits for an approval", async () => {
    await withSession(
      host,
      {
        agent: scriptedAgent((prompt) =>
          prompt.includes('"toolName":"deploy"')
            ? textStreamResult("Deployed.")
            : toolCallsStreamResult([
                { input: "{}", toolCallId: "call_deploy", toolName: "deploy" },
              ]),
        ),
        input: { message: "Alice asks to deploy the api service." },
        modules: [
          sandboxOnTurns(),
          {
            logicalPath: "tools/deploy.ts",
            loadNamespace: async () => ({
              default: defineTool({
                approval: { request: always() },
                description: "Deploy the service.",
                execute: async () => ({ deployed: true }),
                inputSchema: z.object({}).passthrough(),
              }),
            }),
          },
        ],
        name: `idle-approval-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        const asked = await session.nextUntil((event) => event.type === "interaction.opened");
        const opened = asked.at(-1);
        if (opened?.type !== "interaction.opened") throw new Error("No approval was requested.");
        await settle();
        expect(session.events()).toEqual(["definition", "start"]);

        await session.answer(opened.data.interactionId);
        await session.nextUntil((event) => event.type === "turn.settled");
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));
      },
    );
  });
});

describe("idle sandbox check step", () => {
  async function startedSession(sessionId: string, running: SandboxRunning) {
    const serializedContext = {
      ...buildSerializedContext({ channelKind: "http" }),
      "eve.sessionId": sessionId,
    };
    const checkpoint: HarnessSession = {
      compaction: {},
      continuationToken: sessionId,
      history: [],
      sessionId,
    };
    await prewarmSessionStep({
      serializedContext,
      sessionState: createDurableSessionState({ session: checkpoint }),
    });
    const sessionState = createDurableSessionState({
      session: { ...checkpoint, sandboxState: { running, session: null } },
    });
    return async (input: { readonly now: number; readonly stop: boolean }) => {
      const { stateDelta } = await checkSessionSandboxStep({
        ...input,
        serializedContext,
        sessionState,
      });
      const next =
        stateDelta.sessionState === undefined
          ? sessionState
          : applyValueDelta(sessionState, stateDelta.sessionState);
      return readDurableSession(next).sandboxState?.running;
    };
  }

  it.each([
    {
      bound: 120_000,
      name: "a step that may stop, and clears the marker",
      running: { idleTimeoutMs: 60_000 },
      stop: true,
    },
    {
      bound: 30_000,
      name: "a step that only checks, and leaves the state as it was",
      running: { idleTimeoutMs: 60_000, keepRunning: [{ until: 2_000_000, while: "true" }] },
      stop: false,
    },
  ])(
    "aborts a provider that never finishes after its bound for $name",
    async ({ bound, running, stop }) => {
      const called = Promise.withResolvers<AbortSignal | undefined>();
      const hang = async (_sessionId: string, signal: AbortSignal | undefined) => {
        called.resolve(signal);
        await new Promise<never>(() => {});
      };
      const sessionId = `idle-check-hung-${bound}`;
      const runtime = await createTestRuntime({
        sandboxIdle: {
          idleTimeoutMs: 60_000,
          onAttach: stop ? undefined : hang,
          onStop: stop ? hang : undefined,
        },
      });
      await runtime.run(async () => {
        const check = await startedSession(sessionId, running);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        const step = check({ now: 1_000_000, stop });
        const signal = await called.promise;
        await vi.advanceTimersByTimeAsync(bound - 1);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        await expect(step).resolves.toEqual(stop ? undefined : running);
        expect(signal?.aborted).toBe(true);
        expect(runtime.sandboxEvents).toEqual(
          stop
            ? [`definition:${sessionId}`, `start:${sessionId}`, `idle:${sessionId}`]
            : [`definition:${sessionId}`, `start:${sessionId}`],
        );
      });
    },
  );

  const now = 1_000_000;
  const inEffect = { idleTimeoutMs: 60_000, keepRunning: [{ until: now + 60_000, while: "true" }] };
  const ended = { idleTimeoutMs: 60_000, keepRunning: [{ until: now, while: "true" }] };
  it.each([
    {
      name: "a failed check with a record in effect",
      fails: "attach",
      running: inEffect,
      stop: true,
      kept: true,
    },
    {
      name: "a failed stop with a record whose check just failed",
      fails: "stop",
      running: inEffect,
      stop: true,
      kept: true,
    },
    {
      name: "a failed check with nothing in effect",
      fails: "attach",
      running: ended,
      stop: true,
      kept: false,
    },
    {
      name: "a failed stop with nothing in effect",
      fails: "stop",
      running: ended,
      stop: true,
      kept: false,
    },
    {
      name: "a failed check during a turn with nothing in effect",
      fails: "attach",
      running: ended,
      stop: false,
      kept: true,
    },
  ])("follows the failure rule after $name", async ({ fails, kept, running, stop }) => {
    const unavailable = async () => {
      throw new Error("The sandbox service is unavailable.");
    };
    const runtime = await createTestRuntime({
      sandboxIdle: {
        idleTimeoutMs: 60_000,
        onAttach: fails === "attach" ? unavailable : undefined,
        onStop: fails === "stop" ? unavailable : undefined,
      },
      sandboxRun: () => ({ exitCode: 1, stderr: "", stdout: "" }),
    });
    await runtime.run(async () => {
      const check = await startedSession(`idle-check-failed-${fails}-${String(stop)}`, running);

      await expect(check({ now, stop })).resolves.toEqual(kept ? running : undefined);
    });
  });

  it("keeps the session running when the step rejects, and tries again only after the next turn", async () => {
    checkStep.calls = 0;
    checkStep.rejects = true;
    await withSession(
      "in-process",
      {
        input: { message: "Alice opens the project notes." },
        modules: [sandboxOnTurns((turn) => turn === 1)],
        name: "idle-stop-rejected",
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.nextTurn();
        await vi.waitFor(() => expect(checkStep.calls).toBe(1));

        await session.cancel();
        await settle();
        expect(checkStep.calls).toBe(1);

        checkStep.rejects = false;
        await session.send("Alice asks for a short greeting.");
        await session.nextTurn();
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));
        expect(checkStep.calls).toBe(2);
      },
    );
  });
});
